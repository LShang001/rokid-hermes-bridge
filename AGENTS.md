# AGENTS.md — rokid-hermes-bridge

Rokid AR 眼镜接入 Hermes Agent 的桥接服务。作为 WebSocket **客户端**主动外连 Rokid 云
（不是服务端监听），把眼镜消息转成 OpenAI Chat Completions 格式喂给本地 Hermes，SSE 流式回推。
成熟度：可用原型，已真机验证。技术栈：TypeScript (ESM) + ws，无框架。

## 命令

```bash
npm run build    # tsc → dist/
npm run dev      # 编译并运行
npm start        # 只运行 dist/
```

配置从 `.env` 读（`--env-file-if-exists`，需 Node ≥ 20.12）。已设好的环境变量优先于 `.env`，
所以内联覆盖单个值仍然可用：`HERMES_REASONING=high npm start`。

无测试框架。验证方式见 §原则 第 2 条。

## 关键路径

| 路径 | 为什么必须知道 |
|------|---------------|
| `src/hermes-client.ts` | 所有 Hermes 适配都在这里：工具围栏解析、session 头、model_options |
| `src/protocol.ts` | 从 Rokid 官方 openclaw 插件原样复制，改字段会破坏与眼镜端的协议兼容 |

## 原则

1. **协议字段照抄上游** — `protocol.ts` 和下行帧结构对齐 Rokid 官方插件，不要"优化"字段命名
2. **改完必须重放或真机验证** — 无单测；用一次性脚本重放真实 SSE 序列，验完即删，不留在仓库
3. **Hermes 行为先查源码再动手** — 网关实现在 `~/.hermes/hermes-agent/gateway/platforms/api_server.py`，不要猜接口语义
4. **面向语音写回复约束** — 内容会被 TTS 念出来，system prompt 里的口语化/无 markdown 约束不能随手删

## 边界

**绝不修改**：
- `dist/` — tsc 构建产物
- `~/.hermes/config.yaml` 的 `agent.reasoning_effort` — 全局值，会影响用户自己的 CLI；桥接调推理强度只用逐请求 `model_options`

**绝不提交**：
- `.env` — 含真实 linkSecret 和 Hermes API key（已 gitignore）
- 改 `.env.example` 时确认没把真实 key 写进去（曾经发生过，推送前必查）

## 踩坑记录

- Hermes `/v1/chat/completions` **忽略请求里的 `tools`，也从不返回 `tool_calls`**（`api_server.py:3654` 起没有任何解析）。设备指令只能靠 `` ```rokid-tool `` 文本围栏约定实现
- 不带 `X-Hermes-Session-Id` 时，Hermes 用 `hash(system_prompt + 首条 user 消息)` 推导 session id。桥接每次只发当前一句话 → 哈希每轮都变 → 每轮都是新会话、上下文全丢
- Hermes 会把围栏标记按 token 切碎（实测 ` ``` `/`rok`/`id`/`-t`/`ool` 五段分别到达），逐 chunk 正则匹配必然漏判；必须走 `ToolFenceScanner` 缓冲
- 工具调用与文本回复互斥：`sendToolCall` 后立刻 `abort()`。Rokid 协议只有 `answer_stream` 和 `tool_call` 两种下行帧，没有独立状态通道，"思考中"这类提示无处可放
- prompt 基线约 4 万 token（来自 Hermes 全局 MCP 服务器），所以会话必须空闲轮换，否则历史回灌会让首字延迟越聊越慢
