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

需要 Node.js 22+。

Codex-only 模式可以直接运行，不需要额外 npm 包。要使用 Claude Agent，需要先安装依赖：

```bash
npm install
```

Claude 还需要本机已经完成 Claude Code/Claude Agent SDK 的认证配置；如果 SDK 未安装或认证不可用，只会影响 Claude 选项，不会影响 Codex。

如果运行 Claude 时提示找不到 native CLI binary，可以重新安装 optional dependency：

```bash
npm install --include=optional
```

也可以直接指定本机 Claude Code CLI：

```bash
CLAUDE_CODE_EXECUTABLE=/Users/you/.local/bin/claude npm start
```

## 运行

一条命令启动 Relay、Codex App Server 和 Host Agent：

```bash
MOBILE_COMPANION_TOKEN=change-me npm start
```

Windows PowerShell：

```powershell
$env:MOBILE_COMPANION_TOKEN="change-me"; npm start
```

如果 `7331` 已经被其他 Codex app-server 占用，可以换端口：

```bash
MOBILE_COMPANION_TOKEN=change-me CODEX_LISTEN=ws://127.0.0.1:7332 npm start
```

安装到本机命令行：

```bash
npm install -g .
codex-mobile-companion
```

开发时也可以用：

```bash
npm link
codex-mobile-companion
```

Windows PowerShell：

```powershell
$env:MOBILE_COMPANION_TOKEN="change-me"; $env:CODEX_LISTEN="ws://127.0.0.1:7332"; npm start
```

启动后终端会打印本机和局域网访问地址，并为第一个局域网地址生成二维码。手机可以直接扫码访问，也可以手动打开：

```text
http://电脑局域网IP:8787/?token=change-me
```

也可以先在电脑浏览器访问：

```text
http://localhost:8787/?token=change-me
```

## 检查

```bash
npm run check
```

运行 smoke test：

```bash
npm test
```

## 使用方式

- 默认先进入 `项目`，按 `cwd` 查看 Codex 历史项目。
- 未选择项目时，`消息` 和 `历史` 不混合展示所有对话。
- 点进某个项目后，在 `历史` 里只查看该项目下的历史对话。
- 点某条历史对话会读取完整消息，并切回 `消息` 视图；继续输入会接着这条历史线程对话。
- 选择项目但不选择历史线程时，顶部输入框会在该项目下创建新对话。
- 点 `新对话` 会清空当前线程选择，在当前项目下重新开始。
- 当前线程支持收藏、重命名、置顶、归档和导出 Markdown；这些是 Companion 本地元数据，不会改写 Codex/Claude 原始历史。
- 打开某条对话后，Web 端会每隔几秒同步一次当前线程历史；即使消息是在电脑端 Codex 客户端里发的，回复完成后也会自动拉到最新消息。
- 顶部搜索框会过滤当前 Agent 下的项目、历史对话和当前消息。
- `搜索` 页支持跨项目、跨 Agent 全局搜索 Relay 已缓存的线程和消息片段。
- 消息支持基础 Markdown、代码块、diff 增删行样式和复制。
- 点击 `通知` 后，浏览器支持时会在回复完成或需要授权时发送通知。
- `双发` 会把当前输入同时发送给已配置的 Agent，用于快速对比 Codex 和 Claude。
- `设置` 页可以保存当前项目默认 Agent，并查看/撤销浏览器设备 session。
- `设置` 页可以导出完整 JSON 备份，包含 Relay 缓存、线程元数据、授权记录和设备摘要。
- `调试` 页可以查看 Host、Relay、SSE、持久化、设备会话和授权状态。
- 消息流只展示正常对话和关键工作内容，例如 Codex 文本、命令输出、计划和 diff；Host/Codex 连接状态、线程状态等同步事件不会出现在聊天列表里。
- 审批卡片支持同意、会话内同意、拒绝、取消，并显示风险等级；高风险同意会二次确认。
- 手机断线重连时会自动带上 `lastSeq` 拉取遗漏事件。
- 首次扫码 URL 中的共享 token 会换成本地 session token，并从地址栏移除。
- Relay 会把最近事件、线程摘要和授权记录保存到本地状态文件，重启后可恢复。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | Relay HTTP 端口 |
| `HOST` | `0.0.0.0` | Relay 监听地址；手机访问局域网时保持 `0.0.0.0` |
| `MOBILE_COMPANION_TOKEN` | `dev-token` | 手机和 Host Agent 的共享 token |
| `RELAY_URL` | `http://localhost:8787` | Host Agent 连接 Relay 的地址 |
| `CODEX_WS_URL` | `ws://localhost:7331` | Codex App Server WebSocket 地址 |
| `CODEX_LISTEN` | `ws://127.0.0.1:7331` | 一键启动时传给 `codex app-server --listen` 的监听地址 |
| `CODEX_COMMAND` | `codex` | 一键启动时使用的 Codex 命令；Windows 上如果命令名不同可以改这里 |
| `CODEX_WS_AUTH_TOKEN` | 空 | Codex App Server WebSocket token，开启 capability-token 时使用 |
| `CLAUDE_CODE_EXECUTABLE` | 自动查找 | Claude Code CLI 可执行文件路径；SDK native binary 缺失时使用 |
| `CLAUDE_CODE_COMMAND` | 自动查找 | Claude Code CLI 命令名或路径，低优先级兜底 |
| `CLAUDE_PERMISSION_MODE` | `default` | Claude Agent SDK permission mode |
| `WORKDIR` | 当前目录 | 新线程工作目录 |
| `HOST_AGENT_DELAY_MS` | `1200` | 一键启动时 Host Agent 等待 Codex app-server 启动的延迟 |
| `CODEX_START` | `1` | 设置为 `0` 时不启动新的 app-server，复用 `CODEX_WS_URL` 指向的现有服务 |
| `START_QR` | `1` | 设置为 `0` 时不打印终端二维码 |
| `COMPANION_DATA_FILE` | `.companion-data/relay-state.json` | Relay 持久化状态文件 |
| `SESSION_TTL_MS` | `604800000` | 浏览器 session token 有效期，默认 7 天 |

## 安全建议

这是自用 MVP，不建议直接暴露公网。更稳的方式是：

- 只在局域网或 VPN 里访问。
- 设置强 token，不要用默认值。
- 扫码登录后共享 token 会被换成本机 session，但首次 URL 仍要只在可信网络里打开。
- 在 `设置` 页撤销不再使用的设备 session。
- 不要把 Codex App Server 直接监听公网地址。
- 长时间不用时关掉 Relay 和 Host Agent。
- Windows 下首次局域网访问可能需要允许防火墙放行 Node.js 的 `8787` 端口入站连接。

## 多 Agent

顶部 Agent 选择器当前支持：

- `Codex`：通过 Codex App Server WebSocket 连接现有 Codex。
- `Claude`：通过 `@anthropic-ai/claude-agent-sdk` 发起或恢复 Claude 会话。

Host Agent 内部按 Agent adapter 分发请求，后续再增加新的 Agent 时，可以复用 Relay、手机端项目/历史/授权/通知这些通用能力。

`双发` 会为每个 Agent 创建独立新会话，不会把两个 Agent 的回复混在同一条消息列表里。

## 当前限制

- Host Agent 需要 Node.js 22+，依赖内置 `fetch` 和 `WebSocket`。Claude Agent 额外依赖 `@anthropic-ai/claude-agent-sdk`。
- 只实现 WebSocket 方式连接 Codex App Server；Host Agent 和 Relay 之间用 HTTP 长轮询。
- 事件映射按 Codex App Server 常见 JSON-RPC 事件做了兼容处理；不同版本如果方法名有变化，可以在 `host/host-agent.mjs` 的 `handleCodexMessage` 和 `normalizeCodexEvent` 里调整。
- Relay 使用本地 JSON 状态文件保存最近缓存，不替代 Codex/Claude 自己的历史存储。
- 收藏、重命名、置顶、归档和项目默认 Agent 是 Companion 本地设置；如果换设备，需要重新设置或复用同一 Relay 状态文件。
- 全局搜索基于 Relay 当前缓存和已同步历史；未打开或未同步过的远古消息可能不会立刻命中。
- 历史对话来自 Codex app-server 的本地历史接口，不依赖 Relay 内存；但首次读取长线程可能较慢。
- 浏览器通知、PWA 和 Service Worker 在手机局域网 HTTP 页面上可能受浏览器安全策略限制；`localhost`、HTTPS 或已安装 PWA 的环境支持最好。
