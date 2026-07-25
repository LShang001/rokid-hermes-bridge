// ============================================================
// Rokid-Hermes Bridge — 入口
// ============================================================
// 用法:
//   设置环境变量 → npm run dev
//   或: LINK_CODE=xxx LINK_SECRET=yyy node dist/index.js
// ============================================================

import { createBridgeService, type BridgeConfig } from "./ws-bridge.js";

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return isNaN(v) ? fallback : v;
}

const config: BridgeConfig = {
  // Rokid 云
  wsUrl: env("ROKID_WS_URL", "wss://rcs.rokid.com/claw/ws/link"),
  linkCode: env("ROKID_LINK_CODE"),
  linkSecret: env("ROKID_LINK_SECRET"),
  reconnectMaxRetries: envInt("ROKID_RECONNECT_MAX", 10),
  reconnectBaseDelayMs: envInt("ROKID_RECONNECT_DELAY", 1000),

  // Hermes Gateway
  hermes: {
    baseUrl: env("HERMES_BASE_URL", "http://127.0.0.1:8642"),
    apiKey: env("HERMES_API_KEY"),
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
