## Codex Mobile Companion 产品化增强实现说明

任务来源：`.agents/current-task.md` 中第二个 Added Requirement，以及对话中“按顺序继续实现，直到相对完整产品”。

实现目标：在前一轮 MVP 增强基础上继续补齐自用产品闭环，包括依赖锁定、会话管理、消息渲染、安全授权、多设备 session、项目设置、多 Agent 双发、导出和测试文档。

主要实现：
- 执行 `npm install`，安装 `@anthropic-ai/claude-agent-sdk` 并生成 `package-lock.json`。
- 在 `server/relay.mjs` 中新增线程本地元数据 `threadMeta`，支持重命名、置顶、归档并持久化。
- 在 `server/relay.mjs` 中新增 `/api/message/broadcast`、`/api/thread-meta`、`/api/sessions` 和设备 session 撤销接口。
- 在 `public/index.html`、`public/app.js`、`public/styles.css` 中新增新对话、双发、重命名、置顶、归档、导出、设置页和设备 session 列表。
- 在消息渲染中加入轻量 Markdown、代码块、diff 增删行样式和复制按钮。
- 在授权卡片中加入风险等级，高风险授权同意会触发二次确认。
- 在设置页保存当前项目默认 Agent 偏好，作为 Companion 本地设置。
- 扩展 `scripts/smoke.mjs`，覆盖 session 列表/撤销、thread meta、debug 和持久化恢复。
- 更新 `README.md` 说明新增功能和限制。

验证：
- `npm install` 成功。
- `node scripts/check.mjs` 通过。
- `node scripts/smoke.mjs` 通过。
- 使用内置浏览器打开临时 Relay，确认页面加载后 URL token 被移除，新增按钮和设置页可渲染，控制台无 error。

已知后续：
- Claude 真实会话仍依赖本机 Claude 认证状态，需要在实际使用时用 Claude Agent 路径跑一条完整对话。
- 项目默认 Agent 当前是 Companion 本地偏好，不会自动迁移到其它设备。
- 重命名、置顶和归档是 Relay 本地元数据，不会修改 Codex/Claude 原始历史。
