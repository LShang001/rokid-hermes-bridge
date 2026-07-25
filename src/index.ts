// ============================================================
// Rokid-Hermes Bridge — 入口
// ============================================================
// 用法:
//   cp .env.example .env  # 填入配置
//   npm run dev           # 编译并启动（.env 由 --env-file-if-exists 自动加载）
//
//   内联覆盖单个值：HERMES_REASONING=high npm start
//   查看运行时统计：curl http://127.0.0.1:9642/stats  （BRIDGE_HTTP_PORT=0 可禁用）
// ============================================================

import { createServer } from "node:http";
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

const linkCode = env("ROKID_LINK_CODE");

const config: BridgeConfig = {
  // Rokid 云
  wsUrl: env("ROKID_WS_URL", "wss://rcs.rokid.com/claw/ws/link"),
  linkCode,
  linkSecret: env("ROKID_LINK_SECRET"),
  reconnectMaxRetries: envInt("ROKID_RECONNECT_MAX", 10),
  reconnectBaseDelayMs: envInt("ROKID_RECONNECT_DELAY", 1000),
  sessionIdleMs: envInt("ROKID_SESSION_IDLE_SEC", 600) * 1000,

  // 收到请求后立即回送的确认词，消除 Hermes 处理期间的死寂
  // 设为空字符串禁用：BRIDGE_ACK_WORD=""
  ackWord: env("BRIDGE_ACK_WORD", "嗯，"),

  // Hermes Gateway
  hermes: {
    baseUrl: env("HERMES_BASE_URL", "http://127.0.0.1:8642"),
    apiKey: env("HERMES_API_KEY"),
    reasoning: envReasoning("HERMES_REASONING", "off"),
    // 稳定的长期记忆 key（X-Hermes-Session-Key），跨会话轮换持续
    sessionKey: `rokid-${linkCode}`,
    // Hermes 请求超时，防止网关挂住永久阻塞
    requestTimeoutMs: envInt("HERMES_TIMEOUT_SEC", 60) * 1000,
  },
};

function validate(): boolean {
  let ok = true;
  if (!config.linkCode) { console.error("❌ ROKID_LINK_CODE is required"); ok = false; }
  if (!config.linkSecret) { console.error("❌ ROKID_LINK_SECRET is required"); ok = false; }
  if (!config.hermes.apiKey) { console.error("❌ HERMES_API_KEY is required"); ok = false; }
  return ok;
}

const HTTP_PORT = envInt("BRIDGE_HTTP_PORT", 9642);

// ===== 启动 =====

console.log("╔══════════════════════════════════════╗");
console.log("║   Rokid-Hermes Bridge v1.1.0        ║");
console.log("╠══════════════════════════════════════╣");
console.log(`║   Rokid WS:  ${config.wsUrl}`);
console.log(`║   Hermes:    ${config.hermes.baseUrl}`);
console.log(`║   Reasoning: ${config.hermes.reasoning}`);
console.log(`║   LinkCode:  ${config.linkCode}`);
if (HTTP_PORT > 0) {
  console.log(`║   Stats:     http://127.0.0.1:${HTTP_PORT}/stats`);
}
console.log("╚══════════════════════════════════════╝");

if (!validate()) {
  console.error("\n⚠️  请设置环境变量后重试");
  process.exit(1);
}

const service = createBridgeService(config);
service.start();

// ===== HTTP Stats 服务器 =====

let httpServer: ReturnType<typeof createServer> | null = null;

if (HTTP_PORT > 0) {
  httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/stats") {
      const stats = service.getStats();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", endpoints: ["/stats", "/health"] }));
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    console.log(`[http] Stats server listening on http://127.0.0.1:${HTTP_PORT}/stats`);
  });
}

// ===== 优雅退出 =====

async function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down...`);
  await service.stop();
  httpServer?.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
