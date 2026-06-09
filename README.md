# Codex Mobile Companion

一个自用版 Codex 手机伴侣 MVP。电脑端运行 Codex App Server 和 Host Agent，手机打开 Relay 提供的网页，就可以查看线程事件、继续对话、看命令输出/diff，并处理审批请求。

## 架构

```text
codex app-server
      ^
      | JSON-RPC over WebSocket
      v
host/host-agent.mjs
      ^
      | HTTP long polling + POST
      v
server/relay.mjs
      ^
      | Browser REST + SSE
      v
public/ 手机网页
```

## 安装

不需要安装依赖。需要 Node.js 22+。

## 运行

一条命令启动 Relay、Codex App Server 和 Host Agent：

```bash
MOBILE_COMPANION_TOKEN=change-me node scripts/start.mjs
```

如果 `7331` 已经被其他 Codex app-server 占用，可以换端口：

```bash
MOBILE_COMPANION_TOKEN=change-me CODEX_LISTEN=ws://127.0.0.1:7332 node scripts/start.mjs
```

启动后终端会打印本机和局域网访问地址。手机访问：

```text
http://电脑局域网IP:8787/?token=change-me
```

也可以先在电脑浏览器访问：

```text
http://localhost:8787/?token=change-me
```

## 检查

```bash
node scripts/check.mjs
```

## 使用方式

- 默认先进入 `项目`，按 `cwd` 查看 Codex 历史项目。
- 未选择项目时，`消息` 和 `历史` 不混合展示所有对话。
- 点进某个项目后，在 `历史` 里只查看该项目下的历史对话。
- 点某条历史对话会读取完整消息，并切回 `消息` 视图；继续输入会接着这条历史线程对话。
- 选择项目但不选择历史线程时，顶部输入框会在该项目下创建新对话。
- 打开某条对话后，Web 端会每隔几秒同步一次当前线程历史；即使消息是在电脑端 Codex 客户端里发的，回复完成后也会自动拉到最新消息。
- 消息流只展示正常对话和关键工作内容，例如 Codex 文本、命令输出、计划和 diff；Host/Codex 连接状态、线程状态等同步事件不会出现在聊天列表里。
- 审批卡片支持同意、会话内同意、拒绝、取消。
- 手机断线重连时会自动带上 `lastSeq` 拉取遗漏事件。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | Relay HTTP 端口 |
| `HOST` | `0.0.0.0` | Relay 监听地址；手机访问局域网时保持 `0.0.0.0` |
| `MOBILE_COMPANION_TOKEN` | `dev-token` | 手机和 Host Agent 的共享 token |
| `RELAY_URL` | `http://localhost:8787` | Host Agent 连接 Relay 的地址 |
| `CODEX_WS_URL` | `ws://localhost:7331` | Codex App Server WebSocket 地址 |
| `CODEX_LISTEN` | `ws://127.0.0.1:7331` | 一键启动时传给 `codex app-server --listen` 的监听地址 |
| `CODEX_WS_AUTH_TOKEN` | 空 | Codex App Server WebSocket token，开启 capability-token 时使用 |
| `WORKDIR` | 当前目录 | 新线程工作目录 |
| `HOST_AGENT_DELAY_MS` | `1200` | 一键启动时 Host Agent 等待 Codex app-server 启动的延迟 |
| `CODEX_START` | `1` | 设置为 `0` 时不启动新的 app-server，复用 `CODEX_WS_URL` 指向的现有服务 |

## 安全建议

这是自用 MVP，不建议直接暴露公网。更稳的方式是：

- 只在局域网或 VPN 里访问。
- 设置强 token，不要用默认值。
- 不要把 Codex App Server 直接监听公网地址。
- 长时间不用时关掉 Relay 和 Host Agent。

## 当前限制

- Host Agent 需要 Node.js 22+，依赖内置 `fetch` 和 `WebSocket`，不需要安装 npm 包。
- 只实现 WebSocket 方式连接 Codex App Server；Host Agent 和 Relay 之间用 HTTP 长轮询。
- 事件映射按 Codex App Server 常见 JSON-RPC 事件做了兼容处理；不同版本如果方法名有变化，可以在 `host/host-agent.mjs` 的 `handleCodexMessage` 和 `normalizeCodexEvent` 里调整。
- Relay 使用内存存储，重启后线程和事件会清空。
- 历史对话来自 Codex app-server 的本地历史接口，不依赖 Relay 内存；但首次读取长线程可能较慢。
