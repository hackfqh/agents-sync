## 全局搜索、收藏和备份导出实现说明

任务来源：用户要求继续实现下一批产品功能。

实现目标：补齐更适合长期使用的数据治理能力，包括跨 Agent 全局搜索、会话收藏和完整备份导出。

主要实现：
- 在 `server/relay.mjs` 中新增 `/api/search`，可按 `all`、`codex`、`claude` 搜索 Relay 缓存线程和消息片段。
- 在 `server/relay.mjs` 中新增 `/api/export`，导出 Relay 缓存、线程元数据、授权记录和设备摘要。
- 在线程元数据中新增 `starred` 收藏状态，并纳入持久化、排序和导出。
- 在 `public/index.html` 中新增 `搜索` Tab 和全局搜索控件。
- 在 `public/app.js` 中新增全局搜索结果渲染、搜索结果打开、结果页收藏、设置页备份导出。
- 在 `public/styles.css` 中新增搜索页和搜索结果样式。
- 扩展 `scripts/smoke.mjs`，覆盖全局搜索、收藏元数据和备份导出。
- 更新 `README.md` 说明全局搜索、收藏和备份限制。

验证：
- `node scripts/check.mjs` 通过。
- `node scripts/smoke.mjs` 通过。
- 使用内置浏览器打开临时 Relay，确认搜索页可渲染、URL token 已移除、控制台无 error。

已知后续：
- 全局搜索基于 Relay 当前缓存和已同步历史；未同步过的旧消息不会立刻命中。
- 备份导出当前只提供下载，不提供导入恢复流程。
