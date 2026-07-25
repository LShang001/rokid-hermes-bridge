// ============================================================
// Rokid-Hermes Bridge — 入口
// ============================================================
// 用法:
//   cp .env.example .env  # 填入配置
//   npm run dev           # 编译并启动（.env 由 --env-file-if-exists 自动加载）
//
//   内联覆盖单个值：HERMES_REASONING=high npm start
// ============================================================

import { createBridgeService, type BridgeConfig } from "./ws-bridge.js";
import type { ReasoningLevel } from "./hermes-client.js";

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return isNaN(v) ? fallback : v;
}

const REASONING_LEVELS: ReasoningLevel[] = ["off", "low", "medium", "high"];

function envReasoning(key: string, fallback: ReasoningLevel): ReasoningLevel {
  const v = (process.env[key] ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if ((REASONING_LEVELS as string[]).includes(v)) return v as ReasoningLevel;
  console.warn(`⚠️  ${key}="${v}" 无效，可选值：${REASONING_LEVELS.join(" / ")}，回退为 ${fallback}`);
  return fallback;
}

const config: BridgeConfig = {
  // Rokid 云
  wsUrl: env("ROKID_WS_URL", "wss://rcs.rokid.com/claw/ws/link"),
  linkCode: env("ROKID_LINK_CODE"),
  linkSecret: env("ROKID_LINK_SECRET"),
  reconnectMaxRetries: envInt("ROKID_RECONNECT_MAX", 10),
  reconnectBaseDelayMs: envInt("ROKID_RECONNECT_DELAY", 1000),

  // 空闲多久算一次对话结束（默认 10 分钟），超时后开新会话
  sessionIdleMs: envInt("ROKID_SESSION_IDLE_SEC", 600) * 1000,

  // Hermes Gateway
  hermes: {
    baseUrl: env("HERMES_BASE_URL", "http://127.0.0.1:8642"),
    apiKey: env("HERMES_API_KEY"),
    // 眼镜是语音交互，首字延迟比答案深度更重要，默认关闭推理
    reasoning: envReasoning("HERMES_REASONING", "off"),
  },
};

function validate(): boolean {
  let ok = true;
  if (!config.linkCode) { console.error("❌ ROKID_LINK_CODE is required"); ok = false; }
  if (!config.linkSecret) { console.error("❌ ROKID_LINK_SECRET is required"); ok = false; }
  if (!config.hermes.apiKey) { console.error("❌ HERMES_API_KEY is required"); ok = false; }
  return ok;
}

// ===== 启动 =====

console.log("╔══════════════════════════════════════╗");
console.log("║   Rokid-Hermes Bridge v1.0.0        ║");
console.log("╠══════════════════════════════════════╣");
console.log(`║   Rokid WS:  ${config.wsUrl}`);
console.log(`║   Hermes:    ${config.hermes.baseUrl}`);
console.log(`║   Reasoning: ${config.hermes.reasoning}`);
console.log(`║   LinkCode:  ${config.linkCode}`);
console.log("╚══════════════════════════════════════╝");

if (!validate()) {
  console.error("\n⚠️  请设置环境变量后重试");
  process.exit(1);
}

const service = createBridgeService(config);
service.start();

// 优雅退出
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await service.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await service.stop();
  process.exit(0);
});
