// ============================================================
// WebSocket Bridge 核心服务
// 管理 Rokid 云 WebSocket 连接、消息路由到 Hermes、流式回复
// ============================================================

import WebSocket from "ws";
import type { WsBridgeRequest, DeviceToolCall } from "./protocol.js";
import { streamToHermes, type HermesConfig, type TokenUsage } from "./hermes-client.js";

const VERBOSE = process.env.BRIDGE_VERBOSE === "1";

/**
 * 清洗 delta 文本，过滤 Hermes 偶尔混进来的 markdown 符号。
 * TTS 会把 **加粗**、`代码`、# 标题 念出来，必须剥掉。
 */
function cleanForTTS(text: string): string {
  return text
    .replace(/\*\*([^*]*)\*\*/g, "$1")   // **bold** → bold
    .replace(/\*([^*]*)\*/g, "$1")         // *italic* → italic
    .replace(/`([^`]*)`/g, "$1")           // `code` → code
    .replace(/^#{1,6}\s+/gm, "")           // ## 标题 → 标题
    .replace(/^[-*•]\s+/gm, "")            // - 列表项 → 列表项
    .replace(/^\d+\.\s+/gm, "");           // 1. 列表项 → 列表项
}

export interface BridgeConfig {
  wsUrl: string;
  linkCode: string;
  linkSecret: string;
  reconnectMaxRetries: number;
  reconnectBaseDelayMs: number;
  /** 空闲多久后开启新会话（毫秒），避免历史无限增长拖慢首字延迟 */
  sessionIdleMs: number;
  /**
   * 收到请求后立即回送的确认词，消除 Hermes 处理期间的死寂。
   * 默认"嗯，"，设为空字符串禁用。
   */
  ackWord: string;
  hermes: HermesConfig;
}

export interface BridgeStats {
  uptime: number;
  linkCode: string;
  ws: {
    status: "connected" | "disconnected" | "reconnecting";
    reconnectAttempt: number;
  };
  session: {
    id: string | null;
    startedAt: string | null;
    lastActivityAt: string | null;
    rotations: number;
    idleTimeoutSec: number;
  };
  tokens: {
    promptTotal: number;
    completionTotal: number;
    total: number;
    requestCount: number;
    /** 最近一次请求的 prompt token 数，是当前上下文体量的直接指标 */
    lastPromptTokens: number;
  };
}

// ------ 下行帧类型 ------

interface WsBridgeMessageFrame {
  event: "message";
  data: { role: "agent"; message_id: string; agent_id: string; answer_stream: string; is_finish: false; type: "answer" };
}

interface WsBridgeDoneFrame {
  event: "done";
  data: { role: "agent"; message_id: string; agent_id: string; answer_stream: ""; is_finish: true; type: "answer" };
}

interface WsBridgeErrorFrame {
  type: "error"; requestId: string; code: string; message: string;
}

interface WsBridgeStatusFrame {
  type: "status"; connected: boolean;
}

interface WsBridgeToolCallFrame {
  event: "done";
  data: { role: "agent"; message_id: string; agent_id: string; is_finish: true; type: "tool_call"; tool_call: DeviceToolCall };
}

type OutboundFrame =
  | WsBridgeMessageFrame | WsBridgeDoneFrame | WsBridgeErrorFrame
  | WsBridgeStatusFrame | WsBridgeToolCallFrame;

// ------ 工具函数 ------

function buildWsUrl(config: BridgeConfig): string {
  const url = new URL(config.wsUrl);
  url.searchParams.set("linkCode", config.linkCode);
  url.searchParams.set("linkSecret", config.linkSecret);
  return url.toString();
}

function backoffDelay(attempt: number, baseMs: number, maxMs = 30000): number {
  const delay = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(delay + jitter, maxMs);
}

// ------ 主服务 ------

export function createBridgeService(config: BridgeConfig) {
  const startedAt = Date.now();
  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  /** 当前活跃请求的 AbortController */
  let activeCtrl: AbortController | null = null;

  // ------ Session 管理 ------

  let sessionId: string | null = null;
  let sessionStartedAt = 0;
  let lastRequestAt = 0;
  let sessionRotations = 0;

  function resolveSessionId(): string {
    const now = Date.now();
    const expired = lastRequestAt > 0 && now - lastRequestAt > config.sessionIdleMs;
    if (!sessionId || expired) {
      if (expired) {
        console.log(`[ws] Session idle >${Math.round(config.sessionIdleMs / 1000)}s, starting new session`);
        sessionRotations++;
      }
      sessionId = `rokid-${config.linkCode}-${now.toString(36)}`;
      sessionStartedAt = now;
    }
    lastRequestAt = now;
    return sessionId;
  }

  // ------ Stats 追踪 ------

  let wsStatus: BridgeStats["ws"]["status"] = "disconnected";
  let promptTokensTotal = 0;
  let completionTokensTotal = 0;
  let lastPromptTokens = 0;
  let requestCount = 0;

  function recordUsage(usage: TokenUsage) {
    promptTokensTotal += usage.promptTokens;
    completionTokensTotal += usage.completionTokens;
    lastPromptTokens = usage.promptTokens;
  }

  function getStats(): BridgeStats {
    return {
      uptime: Math.round((Date.now() - startedAt) / 1000),
      linkCode: config.linkCode,
      ws: { status: wsStatus, reconnectAttempt },
      session: {
        id: sessionId,
        startedAt: sessionStartedAt > 0 ? new Date(sessionStartedAt).toISOString() : null,
        lastActivityAt: lastRequestAt > 0 ? new Date(lastRequestAt).toISOString() : null,
        rotations: sessionRotations,
        idleTimeoutSec: Math.round(config.sessionIdleMs / 1000),
      },
      tokens: {
        promptTotal: promptTokensTotal,
        completionTotal: completionTokensTotal,
        total: promptTokensTotal + completionTokensTotal,
        requestCount,
        lastPromptTokens,
      },
    };
  }

  // ------ 发送帧 ------

  function sendWs(msg: OutboundFrame) {
    if (ws?.readyState === WebSocket.OPEN) {
      const raw = JSON.stringify(msg);
      if (VERBOSE) console.log(`[ws] >>> ${raw.slice(0, 200)}`);
      ws.send(raw);
    }
  }

  function sendStreamChunk(requestId: string, delta: string) {
    if (!delta) return;
    sendWs({ event: "message", data: { role: "agent", message_id: requestId, agent_id: "hermes", answer_stream: delta, is_finish: false, type: "answer" } });
  }

  function sendDone(requestId: string) {
    sendWs({ event: "done", data: { role: "agent", message_id: requestId, agent_id: "hermes", answer_stream: "", is_finish: true, type: "answer" } });
  }

  function sendToolCall(requestId: string, toolCall: DeviceToolCall) {
    sendWs({ event: "done", data: { role: "agent", message_id: requestId, agent_id: "hermes", is_finish: true, type: "tool_call", tool_call: toolCall } });
  }

  function sendError(requestId: string, message: string) {
    sendWs({ type: "error", requestId, code: "AGENT_ERROR", message });
  }

  // ------ 消息处理 ------

  function handleMessage(raw: string) {
    let msg: unknown;
    try { msg = JSON.parse(raw); }
    catch { console.warn(`[ws] Invalid JSON: ${raw.slice(0, 200)}`); return; }
    if (!msg || typeof msg !== "object") return;
    const parsed = msg as Record<string, unknown>;

    if (parsed.type === "cancel" && typeof parsed.requestId === "string") {
      if (activeCtrl) {
        console.log(`[ws] Cancel request ${parsed.requestId}`);
        activeCtrl.abort();
        activeCtrl = null;
      }
      return;
    }

    const messages = parsed.messages ?? parsed.message;
    const requestId = parsed.requestId ?? parsed.message_id;

    if (Array.isArray(messages) && typeof requestId === "string") {
      void handleChatRequest({ messages: messages as any, requestId, sessionKey: parsed.sessionKey as string | undefined });
      return;
    }

    if (VERBOSE) console.warn(`[ws] Unrecognized message: ${raw.slice(0, 200)}`);
  }

  async function handleChatRequest(request: WsBridgeRequest) {
    if (activeCtrl) {
      console.log(`[ws] Interrupting previous request`);
      activeCtrl.abort();
      activeCtrl = null;
    }

    const ctrl = new AbortController();
    activeCtrl = ctrl;
    // toolCallEmitted 是 request 局部状态，不污染外层闭包
    let toolCallEmitted = false;

    requestCount++;
    const hermesSessionId = resolveSessionId();
    console.log(`[ws] Request #${requestCount} ${request.requestId.slice(-8)} session=${hermesSessionId.slice(-8)}`);

    // 立即回送确认词，消除 Hermes 处理期间的 2s 死寂
    if (config.ackWord) {
      sendStreamChunk(request.requestId, config.ackWord);
    }

    try {
      await streamToHermes(config.hermes, request.messages, hermesSessionId, ctrl.signal, {
        onDelta: (delta) => {
          if (ctrl.signal.aborted || toolCallEmitted) return;
          sendStreamChunk(request.requestId, cleanForTTS(delta));
        },
        onToolCall: (toolCall) => {
          if (ctrl.signal.aborted || toolCallEmitted) return;
          toolCallEmitted = true;
          console.log(`[ws] Tool call: ${toolCall.command}`);
          sendToolCall(request.requestId, toolCall);
          ctrl.abort();
        },
        onDone: () => {
          if (ctrl.signal.aborted || toolCallEmitted) return;
          sendDone(request.requestId);
        },
        onError: (err) => {
          console.error(`[ws] Hermes error: ${err.message}`);
          if (!ctrl.signal.aborted && !toolCallEmitted) sendError(request.requestId, err.message);
        },
        onUsage: (usage) => {
          recordUsage(usage);
          if (VERBOSE) console.log(`[ws] Tokens prompt=${usage.promptTokens} completion=${usage.completionTokens}`);
        },
      });
    } catch (err: any) {
      console.error(`[ws] Request failed: ${err.message}`);
      if (!ctrl.signal.aborted && !toolCallEmitted) sendError(request.requestId, err.message);
    } finally {
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  }

  // ------ 连接管理 ------

  function connect() {
    if (stopped) return;

    const fullWsUrl = buildWsUrl(config);
    console.log(`[ws] Connecting (attempt ${reconnectAttempt + 1})...`);
    wsStatus = "reconnecting";

    ws = new WebSocket(fullWsUrl);

    ws.on("open", () => {
      reconnectAttempt = 0;
      wsStatus = "connected";
      console.log(`[ws] Connected to Rokid cloud`);
      sendWs({ type: "status", connected: true });

      // 心跳：每 30 秒 ping 一次，检测半开 TCP 连接
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30_000);
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      if (VERBOSE) console.log(`[ws] <<< ${raw.slice(0, 300)}`);
      handleMessage(raw);
    });

    ws.on("close", (code) => {
      wsStatus = "disconnected";
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      console.warn(`[ws] Disconnected (code=${code})`);
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[ws] Error: ${err.message}`);
    });
  }

  function scheduleReconnect() {
    if (stopped) return;

    // 耗尽初始重试次数后不再放弃，改为每 5 分钟重试一次
    const exhausted = reconnectAttempt >= config.reconnectMaxRetries;
    const delay = exhausted
      ? 5 * 60 * 1000
      : backoffDelay(reconnectAttempt, config.reconnectBaseDelayMs);

    reconnectAttempt++;
    wsStatus = "reconnecting";

    if (exhausted) {
      console.warn(`[ws] Initial retries exhausted, switching to 5-min interval (attempt ${reconnectAttempt})`);
    } else {
      console.log(`[ws] Reconnecting in ${Math.round(delay / 1000)}s...`);
    }

    reconnectTimer = setTimeout(connect, delay);
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (activeCtrl) { activeCtrl.abort(); activeCtrl = null; }
      if (ws) { ws.removeAllListeners(); if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Shutdown"); ws = null; }
      wsStatus = "disconnected";
      console.log("[ws] Service stopped");
    },
    getStats,
  };
}
