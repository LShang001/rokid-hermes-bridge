# rokid-hermes-bridge

把 Rokid AR 眼镜接入 [Hermes Agent](https://github.com/hermes-ai/hermes-agent) 的桥接服务。

参考并简化自 Rokid 官方的 [openclaw 插件](https://gitee.com/rokid-eco/rokid-openclaw-gateway-compatible)，去掉了 openclaw SDK 依赖，改为直接对接 Hermes 的 OpenAI 兼容 `/v1/chat/completions` 接口。

## 架构

```
Rokid 眼镜 <──wss──> rcs.rokid.com/claw/ws/link <──wss──> 本桥接服务 <──http/SSE──> Hermes Gateway
```

桥接服务作为 WebSocket **客户端**主动连接 Rokid 云（`wss://rcs.rokid.com/claw/ws/link`），用设备配对的 `linkCode`/`linkSecret` 鉴权。眼镜端发来的消息转换成 OpenAI Chat Completions 格式，POST 给本地 Hermes Gateway，SSE 流式响应再转成 Rokid 协议帧推回眼镜。

## 安装

```bash
npm install
npm run build
cp .env.example .env
# 编辑 .env，填入 ROKID_LINK_CODE / ROKID_LINK_SECRET / HERMES_API_KEY
npm start
```

开发模式（改完直接编译+运行）：

```bash
npm run dev
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ROKID_LINK_CODE` | 是 | 设备配对码，眼镜配对界面提供 |
| `ROKID_LINK_SECRET` | 是 | 设备配对密钥 |
| `HERMES_API_KEY` | 是 | Hermes Gateway 的 API key |
| `HERMES_BASE_URL` | 否 | 默认 `http://127.0.0.1:8642` |
| `ROKID_WS_URL` | 否 | 默认 `wss://rcs.rokid.com/claw/ws/link`，通常不需要改 |
| `ROKID_RECONNECT_MAX` | 否 | 断线重连最大次数，默认 10 |
| `ROKID_RECONNECT_DELAY` | 否 | 重连基础延迟（毫秒），默认 1000 |
| `HERMES_REASONING` | 否 | 思考强度 `off`/`low`/`medium`/`high`，默认 `off` |
| `ROKID_SESSION_IDLE_SEC` | 否 | 空闲多久开新会话（秒），默认 600 |

**注意**：本项目不依赖 `dotenv`，`.env` 文件不会被自动加载。运行前需要自己 `export` 这些变量，或者用 `dotenv-cli` / `env-cmd` 之类的工具，或者直接在命令行内联传入：

```bash
ROKID_LINK_CODE=xxx ROKID_LINK_SECRET=yyy HERMES_API_KEY=zzz npm start
```

## 设备工具调用（拍照/导航/日程/退出）

Hermes 的 `/v1/chat/completions` 不支持 OpenAI 的 `tools` 参数，也不会在响应里返回 `tool_calls`——它是一个不透明的 agent 循环，工具执行发生在服务端内部，暴露给客户端的只有文本流。

因此设备指令改用**文本约定**：每次请求都会前置一条 system 消息，要求 Hermes 在需要设备动作时输出如下格式的代码块：

```
说话内容...
```rokid-tool
{"command": "take_photo"}
```
说话内容...
```

`hermes-client.ts` 里的 `ToolFenceScanner` 负责流式扫描 SSE 增量、识别并抽取这个代码块（即使标记被逐 token 切碎也能正确识别），代码块之外的文本正常转发给设备语音播报，代码块内容解析成 `DeviceToolCall` 并触发对应设备动作。

支持的 command：`take_photo`、`take_navigation`（`action: open/close`，`poi_name`，`navi_type: 0驾车/1步行/2骑行`）、`control_calendar`（`action: create`，`title`，`start_time`/`end_time` ISO 8601）、`notify_agent_off`。

**已知限制**：这是提示工程层面的约定，不是协议层的结构化保证。模型可能偶尔不遵循格式（说了要拍照但没输出代码块），或格式输出有误。生产使用前建议做实际语音场景的触发率测试。

## 多轮上下文

桥接每次请求都会带上 `X-Hermes-Session-Id`，让 Hermes 从 `state.db` 读取真实会话历史。

这个头**必须带**：不带时 Hermes 会用 `hash(system_prompt + 首条 user 消息)` 推导 session id（为 Open WebUI 那类"每轮回传完整历史"的客户端设计），而桥接每次只发当前一句话，哈希每轮都变，结果每说一句都开新会话、上下文全丢。

会话 id 形如 `rokid-<linkCode>-<base36 时间戳>`，空闲超过 `ROKID_SESSION_IDLE_SEC`（默认 600 秒）后轮换。轮换是必要的：会话内 Hermes 会把历史回灌进 prompt，而 prompt 基线本就有数万 token，无限增长会让首字延迟越聊越慢。

## 思考强度与延迟

眼镜是语音交互，首字延迟比答案深度更重要，所以默认关闭推理。桥接通过逐请求的 `model_options` 覆盖，**不改动 Hermes 全局配置**——你在电脑上用 CLI 走 `cli` 平台，眼镜走 `api_server` 平台，两条路各自独立。

同一问题的实测首字延迟：

| `HERMES_REASONING` | 首字延迟 |
| --- | --- |
| 默认（不覆盖） | 5218 ms |
| `low` | 4031 ms |
| `off`（本项目默认） | 2125 ms |

回复本身是逐帧流式推给眼镜的（`answer_stream` 增量帧），瓶颈在开口前的等待，不在播报过程。

## 项目结构

```
src/
├── index.ts          入口，环境变量 → 配置 → 启动
├── protocol.ts        Rokid 消息协议类型定义
├── ws-bridge.ts        Rokid WebSocket 连接/重连/消息路由
└── hermes-client.ts   Hermes SSE 流式调用 + 工具约定解析
```

## License

MIT
