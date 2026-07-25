// ============================================================
// WebSocket Bridge Protocol — 消息类型定义
// 直接复用 OpenClaw 插件协议，不做修改
// ============================================================

/** 单条消息对象（支持文本与图片） */
export interface MessageObject {
  role: "user" | "agent";
  type: "text" | "image";
  text?: string;
  image_url?: string;
}

/** 用户服务推送的消息 */
export interface WsBridgeRequest {
  messages: MessageObject[];
  requestId: string;
  sessionKey?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
}

/** 取消正在进行的请求 */
export interface WsBridgeCancel {
  type: "cancel";
  requestId: string;
}

export type InboundMessage = WsBridgeRequest | WsBridgeCancel;

// ------ 设备工具调用帧（插件 → 设备） ------

export interface DeviceToolCall {
  command: string;
  action?: string;
  poi_name?: string;
  navi_type?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
}

export interface WsBridgeToolCallFrame {
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
