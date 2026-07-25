// ============================================================
// WebSocket Bridge 核心服务
// 管理 Rokid 云 WebSocket 连接、消息路由到 Hermes、流式回复
// ============================================================

import WebSocket from "ws";
import type { WsBridgeRequest, DeviceToolCall } from "./protocol.js";
import { streamToHermes, type HermesConfig } from "./hermes-client.js";

export interface BridgeConfig {
  /** Rokid 云 WebSocket 地址 */
  wsUrl: string;
  /** 设备 linkCode */
  linkCode: string;
  /** 设备 linkSecret */
  linkSecret: string;
  /** 重连最大次数 */
  reconnectMaxRetries: number;
  /** 重连基础延迟 (ms) */
  reconnectBaseDelayMs: number;
  /** Hermes Gateway 配置 */
  hermes: HermesConfig;
}

// ------ 下行帧类型 ------

interface WsBridgeMessageFrame {
  event: "message";
  data: {
    role: "agent";
    message_id: string;
    agent_id: string;
    answer_stream: string;
    is_finish: false;
    type: "answer";
  };
}

interface WsBridgeDoneFrame {
  event: "done";
  data: {
    role: "agent";
    message_id: string;
    agent_id: string;
    answer_stream: "";
    is_finish: true;
    type: "answer";
  };
}

interface WsBridgeErrorFrame {
  type: "error";
  requestId: string;
  code: string;
  message: string;
}

interface WsBridgeStatusFrame {
  type: "status";
  connected: boolean;
}

interface WsBridgeToolCallFrame {
  event: "done";
  data: {
    role: "agent";
    message_id: string;
    agent_id: string;
    is_finish: true;
    type: "tool_call";
    tool_call: DeviceToolCall;
  };
}

type OutboundFrame =
  | WsBridgeMessageFrame
  | WsBridgeDoneFrame
  | WsBridgeErrorFrame
  | WsBridgeStatusFrame
  | WsBridgeToolCallFrame;

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
  let ws: WebSocket | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let toolCallEmitted = false;

  /** 当前活跃请求的 AbortController */
  let activeCtrl: AbortController | null = null;

  function sendWs(msg: OutboundFrame) {
    if (ws?.readyState === WebSocket.OPEN) {
      const raw = JSON.stringify(msg);
      console.log(`[ws] >>> ${raw.slice(0, 200)}`);
      ws.send(raw);
    }
  }

  function sendStreamChunk(requestId: string, delta: string) {
    if (!delta) return;
    sendWs({
      event: "message",
      data: {
        role: "agent",
        message_id: requestId,
        agent_id: "hermes",
        answer_stream: delta,
        is_finish: false,
        type: "answer",
      },
    });
  }

  function sendDone(requestId: string) {
    sendWs({
      event: "done",
      data: {
        role: "agent",
        message_id: requestId,
        agent_id: "hermes",
        answer_stream: "",
        is_finish: true,
        type: "answer",
      },
    });
  }

  function sendToolCall(requestId: string, toolCall: DeviceToolCall) {
    toolCallEmitted = true;
    sendWs({
      event: "done",
      data: {
        role: "agent",
        message_id: requestId,
        agent_id: "hermes",
        is_finish: true,
        type: "tool_call",
        tool_call: toolCall,
      },
    });
  }

  function sendError(requestId: string, message: string) {
    sendWs({ type: "error", requestId, code: "AGENT_ERROR", message });
  }

  // ------ 消息处理 ------

  function handleMessage(raw: string) {
    let msg: unknown;
    try { msg = JSON.parse(raw); }
    catch {
      console.warn(`[ws] Invalid JSON: ${raw.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const parsed = msg as Record<string, unknown>;

    // 取消
    if (parsed.type === "cancel" && typeof parsed.requestId === "string") {
      if (activeCtrl) {
        console.log(`[ws] Cancel request ${parsed.requestId}`);
        activeCtrl.abort();
        activeCtrl = null;
      }
      return;
    }

    // 兼容两种字段名
    const messages = parsed.messages ?? parsed.message;
    const requestId = parsed.requestId ?? parsed.message_id;

    if (Array.isArray(messages) && typeof requestId === "string") {
      void handleChatRequest({
        messages: messages as any,
        requestId,
        sessionKey: parsed.sessionKey as string | undefined,
      });
      return;
    }

    console.warn(`[ws] Unrecognized message: ${raw.slice(0, 200)}`);
  }

  async function handleChatRequest(request: WsBridgeRequest) {
    // 打断上一个请求
    if (activeCtrl) {
      console.log(`[ws] Interrupting previous request`);
      activeCtrl.abort();
      activeCtrl = null;
    }

    const ctrl = new AbortController();
    activeCtrl = ctrl;
    toolCallEmitted = false;

    console.log(`[ws] Processing request ${request.requestId}, messages=${request.messages.length}`);

    try {
      await streamToHermes(config.hermes, request.messages, ctrl.signal, {
        onDelta: (delta) => {
          if (ctrl.signal.aborted || toolCallEmitted) return;
          sendStreamChunk(request.requestId, delta);
        },
        onToolCall: (toolCall) => {
          if (ctrl.signal.aborted || toolCallEmitted) return;
          console.log(`[ws] Tool call: ${JSON.stringify(toolCall)}`);
          sendToolCall(request.requestId, toolCall);
          ctrl.abort();
        },
        onDone: () => {
          if (ctrl.signal.aborted || toolCallEmitted) return;
          sendDone(request.requestId);
        },
        onError: (err) => {
          console.error(`[ws] Hermes error: ${err.message}`);
          if (!ctrl.signal.aborted && !toolCallEmitted) {
            sendError(request.requestId, err.message);
          }
        },
      });
    } catch (err: any) {
      console.error(`[ws] Request ${request.requestId} failed: ${err.message}`);
      if (!ctrl.signal.aborted && !toolCallEmitted) {
        sendError(request.requestId, err.message);
      }
    } finally {
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  }

  // ------ 连接管理 ------

  function connect() {
    if (stopped) return;

    const fullWsUrl = buildWsUrl(config);
    console.log(`[ws] Connecting (attempt ${reconnectAttempt + 1})...`);

    ws = new WebSocket(fullWsUrl);

    ws.on("open", () => {
      reconnectAttempt = 0;
      console.log(`[ws] Connected to Rokid cloud`);
      sendWs({ type: "status", connected: true });
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      console.log(`[ws] <<< ${raw.slice(0, 300)}`);
      handleMessage(raw);
    });

    ws.on("close", (code, reason) => {
      console.warn(`[ws] Disconnected (code=${code})`);
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[ws] Error: ${err.message}`);
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectAttempt >= config.reconnectMaxRetries) {
      console.error(`[ws] Max retries (${config.reconnectMaxRetries}) exhausted. Giving up.`);
      return;
    }
    const delay = backoffDelay(reconnectAttempt, config.reconnectBaseDelayMs);
    reconnectAttempt++;
    console.log(`[ws] Reconnecting in ${Math.round(delay)}ms...`);
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
      if (activeCtrl) { activeCtrl.abort(); activeCtrl = null; }
      if (ws) { ws.removeAllListeners(); if (ws.readyState === WebSocket.OPEN) ws.close(1000, "Shutdown"); ws = null; }
      console.log("[ws] Service stopped");
    },
  };
}
