// ============================================================
// Hermes Gateway HTTP 客户端 — 流式调用 + SSE 解析
// ============================================================

import type { MessageObject, DeviceToolCall } from "./protocol.js";

/** 思考强度：off 关闭推理（最快），其余为 Hermes 的 effort 档位 */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
  /** 眼镜场景默认降低思考强度以压低首字延迟 */
  reasoning: ReasoningLevel;
}

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onToolCall: (toolCall: DeviceToolCall) => void;
  onDone: () => void;
  onError: (error: Error) => void;
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
          // 缓冲区尾部可能是围栏标记的前缀，保留待续；其余部分可以安全放出
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

  /** 上一次 push() 中是否闭合了一个工具围栏；取出其原始 JSON 文本 */
  pendingToolJson: string | null = null;

  takePendingToolJson(): string | null {
    const v = this.pendingToolJson;
    this.pendingToolJson = null;
    return v;
  }

  /** 流结束时缓冲区里剩余的纯文本（未闭合的围栏视为普通文本原样吐出） */
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

  /** 计算 buffer 中可以安全输出的前缀长度，避免切断跨 chunk 的围栏标记 */
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

const TOOL_CONVENTION_SYSTEM_PROMPT = `你现在通过 Rokid AR 眼镜和用户语音对话，回复会被逐字转成语音播报给用户听，不是显示成文档。请遵守：
- 用口语化的短句回答，像日常聊天一样，不要用书面语或列举式的长篇说明。
- 不要使用任何 markdown 语法（不要加粗 **、不要用标题 #、不要用列表 - / 1.、不要用代码块围栏，除非是下面的设备指令约定）。
- 一般问题控制在 2-3 句话以内说完重点，不要展开成大段罗列。
- 不要暴露内部实现细节（文件路径、代码、工具名、技术架构），用户只是在和眼镜对话，不需要知道这些。

如果需要下发设备指令（拍照/导航/日程/退出），不要用普通文字描述，而是在回复中单独输出如下格式的代码块（可以在代码块前后正常说话）：

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
      // 先提交累积的文本
      if (textParts.length > 0) {
        parts.push({ type: "text", text: textParts.join("\n") });
        textParts = [];
      }
      parts.push({ type: "image_url", image_url: { url: msg.image_url } });
    }
  }
  // 提交剩余文本
  if (textParts.length > 0) {
    parts.push({ type: "text", text: textParts.join("\n") });
  }

  const systemMsg: OpenAIMessage = { role: "system", content: TOOL_CONVENTION_SYSTEM_PROMPT };

  // 纯文本消息用简单格式
  if (parts.length === 1 && parts[0].type === "text") {
    return [systemMsg, { role: "user", content: parts[0].text! }];
  }
  // 多模态消息
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

  // model_options 是 Hermes 的逐请求运行时覆盖，只影响本次调用，
  // 不改动 Hermes 全局配置（CLI 等其它平台不受影响）。
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
  console.log(`[hermes] → POST ${url} (${body.length} bytes)`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // 不带此头时 Hermes 会用 hash(system_prompt + 首条 user 消息) 推导
        // session id，而桥接每次只发当前一句话，导致每轮都变成新会话、
        // 上下文丢失。显式带上稳定 id，让 Hermes 从 state.db 读取历史。
        "X-Hermes-Session-Id": sessionId,
      },
      body,
      signal,
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
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          // 文本增量：经围栏扫描器过滤出 ```rokid-tool 代码块
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
          // 忽略解析失败的行
        }
      }
    }
    const rest = fenceScanner.flush();
    if (rest) callbacks.onDelta(rest);
    callbacks.onDone();
  } catch (err: any) {
    if (err.name === "AbortError") return;
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
