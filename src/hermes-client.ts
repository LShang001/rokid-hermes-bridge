// ============================================================
// Hermes Gateway HTTP 客户端 — 流式调用 + SSE 解析
// ============================================================

import type { MessageObject, DeviceToolCall } from "./protocol.js";

const VERBOSE = process.env.BRIDGE_VERBOSE === "1";

/** 思考强度：off 关闭推理（最快），其余为 Hermes 的 effort 档位 */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
  /** 眼镜场景默认降低思考强度以压低首字延迟 */
  reasoning: ReasoningLevel;
  /**
   * 稳定的长期记忆 key（X-Hermes-Session-Key）。
   * 不同于会话 id（空闲后轮换），此 key 跨会话持续，
   * 让 Hermes 的 Honcho 记忆层在换了 session 后依然认识你。
   */
  sessionKey: string;
  /** Hermes 请求超时（毫秒），默认 60000 */
  requestTimeoutMs: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onToolCall: (toolCall: DeviceToolCall) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  /** Hermes 在最后一帧里返回本次请求的 token 用量 */
  onUsage?: (usage: TokenUsage) => void;
}

const TOOL_FENCE_OPEN = "```rokid-tool";
const TOOL_FENCE_CLOSE = "```";
const KNOWN_COMMANDS = ["take_photo", "take_navigation", "control_calendar", "notify_agent_off"];

/**
 * Hermes 不支持 OpenAI tool_calls，改用文本约定：
 * agent 在需要设备动作时输出 ```rokid-tool\n{...}\n``` 代码块。
 * 增量到达时可能被截断在标记中间，所以维护一个小缓冲区，
 * 只有确认不是围栏起始的文本才立即经 onDelta 放出去。
 */
export class ToolFenceScanner {
  private buffer = "";
  private inFence = false;
  private fenceBody = "";

  /** 喂入一段增量文本，返回应立即转发给下游的纯文本（可能为空） */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";

    while (true) {
      if (!this.inFence) {
        const idx = this.buffer.indexOf(TOOL_FENCE_OPEN);
        if (idx === -1) {
          const safeLen = this.longestSafeSuffixCut(this.buffer, TOOL_FENCE_OPEN);
          out += this.buffer.slice(0, safeLen);
          this.buffer = this.buffer.slice(safeLen);
          break;
        }
        out += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + TOOL_FENCE_OPEN.length);
        this.inFence = true;
        this.fenceBody = "";
        continue;
      }

      const closeIdx = this.buffer.indexOf(TOOL_FENCE_CLOSE);
      if (closeIdx === -1) {
        this.fenceBody += this.buffer;
        this.buffer = "";
        break;
      }
      this.fenceBody += this.buffer.slice(0, closeIdx);
      this.buffer = this.buffer.slice(closeIdx + TOOL_FENCE_CLOSE.length);
      this.inFence = false;
      this.pendingToolJson = this.fenceBody.trim();
      this.fenceBody = "";
    }

    return out;
  }

  pendingToolJson: string | null = null;

  takePendingToolJson(): string | null {
    const v = this.pendingToolJson;
    this.pendingToolJson = null;
    return v;
  }

  flush(): string {
    if (this.inFence) {
      const rest = TOOL_FENCE_OPEN + this.fenceBody + this.buffer;
      this.inFence = false;
      this.fenceBody = "";
      this.buffer = "";
      return rest;
    }
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  private longestSafeSuffixCut(buffer: string, marker: string): number {
    const maxOverlap = Math.min(marker.length - 1, buffer.length);
    for (let len = maxOverlap; len > 0; len--) {
      if (marker.startsWith(buffer.slice(buffer.length - len))) {
        return buffer.length - len;
      }
    }
    return buffer.length;
  }
}

export function parseToolFenceJson(raw: string): DeviceToolCall | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.command !== "string") return null;
    if (!KNOWN_COMMANDS.includes(parsed.command)) return null;
    return parsed as DeviceToolCall;
  } catch {
    return null;
  }
}

const TOOL_CONVENTION_SYSTEM_PROMPT = `你现在通过 Rokid AR 眼镜和用户语音对话，回复会被逐字转成语音播报给用户听。

**回复风格（严格遵守）：**
- 直接给出答案，不要用"好的""当然""稍等""没问题"等开场白——第一句话就是答案
- 口语化短句，像朋友聊天，不要书面语或长篇说明
- 一般问题 2 句以内说完，复杂问题最多 3 句
- 不使用任何 markdown 符号（不加粗、不用标题、不用列表符号、不用代码围栏，除下方设备指令约定外）
- 不暴露内部实现细节（文件路径、工具名、技术架构）

如果需要下发设备指令（拍照/导航/日程/退出），在回复中输出如下格式的代码块（可在代码块前后正常说话）：

\`\`\`rokid-tool
{"command": "take_photo"}
\`\`\`

支持的 command 及参数：
- take_photo：无参数
- take_navigation：{"command":"take_navigation","action":"open"|"close","poi_name":"目的地","navi_type":"0"|"1"|"2"}（0驾车/1步行/2骑行）
- control_calendar：{"command":"control_calendar","action":"create","title":"标题","start_time":"ISO8601","end_time":"ISO8601（可选）"}
- notify_agent_off：无参数

只有确定需要触发设备动作时才输出该代码块，正常聊天不要输出。`;

type OpenAIMessage = { role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };

/**
 * 将 Rokid MessageObject[] 转为 OpenAI Chat Completions 格式，
 * 并前置工具约定的 system 消息（Hermes 不支持 tools 字段，见 TOOL_CONVENTION_SYSTEM_PROMPT）
 */
function toOpenAIMessages(messages: MessageObject[]): OpenAIMessage[] {
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  let textParts: string[] = [];

  for (const msg of messages) {
    if (msg.type === "text" && msg.text) {
      textParts.push(msg.text);
    } else if (msg.type === "image" && msg.image_url) {
      if (textParts.length > 0) {
        parts.push({ type: "text", text: textParts.join("\n") });
        textParts = [];
      }
      parts.push({ type: "image_url", image_url: { url: msg.image_url } });
    }
  }
  if (textParts.length > 0) {
    parts.push({ type: "text", text: textParts.join("\n") });
  }

  const systemMsg: OpenAIMessage = { role: "system", content: TOOL_CONVENTION_SYSTEM_PROMPT };

  if (parts.length === 1 && parts[0].type === "text") {
    return [systemMsg, { role: "user", content: parts[0].text! }];
  }
  return [systemMsg, { role: "user", content: parts }];
}

/**
 * 流式调用 Hermes Agent
 * 通过 /v1/chat/completions 发送消息，SSE 流式接收回复
 */
export async function streamToHermes(
  config: HermesConfig,
  messages: MessageObject[],
  sessionId: string,
  signal: AbortSignal,
  callbacks: StreamCallbacks
): Promise<void> {
  const openaiMessages = toOpenAIMessages(messages);

  const reasoning =
    config.reasoning === "off"
      ? { enabled: false }
      : { enabled: true, effort: config.reasoning };

  const body = JSON.stringify({
    model: "hermes-agent",
    messages: openaiMessages,
    stream: true,
    model_options: { reasoning },
  });

  const url = `${config.baseUrl}/v1/chat/completions`;
  if (VERBOSE) console.log(`[hermes] → POST ${url} (${body.length} bytes)`);

  // 请求超时：独立于 signal（signal 处理打断，timeout 处理 Hermes 挂住）
  const timeoutSignal = AbortSignal.timeout(config.requestTimeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // 会话历史：Hermes 从 state.db 读取，不再靠 hash(system+首句) 推导
        "X-Hermes-Session-Id": sessionId,
        // 长期记忆 key：跨会话轮换持续，Honcho 用它识别同一用户
        "X-Hermes-Session-Key": config.sessionKey,
      },
      body,
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Hermes API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    const fenceScanner = new ToolFenceScanner();
    let toolCallEmitted = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          const rest = fenceScanner.flush();
          if (rest) callbacks.onDelta(rest);
          callbacks.onDone();
          return;
        }
        try {
          const parsed = JSON.parse(data);

          // 顶层 usage 字段（在最后一个有 finish_reason 的帧里）
          if (parsed.usage?.prompt_tokens) {
            callbacks.onUsage?.({
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            });
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta?.content;
          if (delta) {
            const safeText = fenceScanner.push(delta);
            if (safeText) callbacks.onDelta(safeText);

            const toolJson = fenceScanner.takePendingToolJson();
            if (toolJson) {
              const deviceCall = parseToolFenceJson(toolJson);
              if (deviceCall && !toolCallEmitted) {
                toolCallEmitted = true;
                callbacks.onToolCall(deviceCall);
              }
            }
          }
        } catch {
          // 忽略解析失败的行（hermes.tool.progress 等自定义事件）
        }
      }
    }
    const rest = fenceScanner.flush();
    if (rest) callbacks.onDelta(rest);
    callbacks.onDone();
  } catch (err: any) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      if (err.name === "TimeoutError") {
        console.error(`[hermes] Request timed out after ${config.requestTimeoutMs}ms`);
        callbacks.onError(new Error(`Hermes request timed out after ${config.requestTimeoutMs}ms`));
      }
      return;
    }
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
