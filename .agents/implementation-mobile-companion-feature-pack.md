## Codex Mobile Companion 功能增强实现说明

任务来源：`.agents/current-task.md` 中的 Added Requirement，以及当前对话中“把以上的功能点都按顺序实现下”。

实现目标：在不破坏现有 Codex 手机伴侣功能的前提下，补齐初始化修复、Claude 收尾、搜索、通知、持久化、多 Agent 适配层、PWA、安全增强、调试页和自动化检查。

主要实现：
- 修复 `public/app.js` 中 `agentStorageKey` 依赖 `state` 初始化顺序的问题，改为显式传入 Agent 或从本地存储兜底。
- 在 `public/index.html`、`public/app.js`、`public/styles.css` 中新增搜索栏、通知按钮和调试视图。
- 在 `server/relay.mjs` 中新增浏览器 session token、`/api/session`、`/api/debug`，并把事件、线程、授权写入本地 JSON 状态文件。
- 在 `host/host-agent.mjs` 中增加 Agent adapter 分发层，Codex 和 Claude 通过统一入口处理消息、项目、历史读取。
- 新增 `public/sw.js`、`public/icon.svg` 并完善 `public/manifest.json`，提供基础 PWA 能力。
- 更新 `README.md`，说明 Claude SDK 可选依赖、通知、搜索、调试、持久化和安全行为。
- 新增 `scripts/smoke.mjs`，并扩展 `scripts/check.mjs` 与 `package.json` 脚本。

验证：
- 执行 `node scripts/check.mjs`，通过语法和 manifest 检查。
- 执行 `node scripts/smoke.mjs`，通过 session、debug、持久化恢复 smoke test。
- 使用内置浏览器打开 `http://127.0.0.1:18888/?token=ui-test`，确认页面加载后 URL token 被移除，调试页可渲染，控制台无 error。

已知后续：
- Claude SDK 真实运行仍需要本机执行 `npm install` 并完成 Claude 认证后验证。
- 浏览器通知、Service Worker 和 PWA 在局域网 HTTP 手机上可能受浏览器安全策略限制，HTTPS 或 localhost 支持更稳定。
