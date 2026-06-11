## 修复 Claude CLI binary 查找问题

任务来源：用户反馈 `Claude 运行失败：Native CLI binary for darwin-arm64 not found...`。

实现目标：当 `@anthropic-ai/claude-agent-sdk` 的 optional native binary 未安装时，Host Agent 能自动使用本机已有的 Claude Code CLI，避免 Claude 功能直接失败。

主要实现：
- 在 `host/host-agent.mjs` 中新增 Claude CLI 可执行文件解析逻辑。
- 优先读取 `CLAUDE_CODE_EXECUTABLE`、`CLAUDE_CODE_COMMAND`、`CLAUDE_EXECUTABLE`。
- 未配置时从 `PATH` 和常见路径查找 `claude`，包括 macOS/Linux 的 `~/.local/bin/claude`、`/opt/homebrew/bin/claude`、`/usr/local/bin/claude`。
- 找到后传入 Claude Agent SDK 的 `options.pathToClaudeCodeExecutable`。
- 对 native binary 缺失错误追加中文修复建议。
- 更新 `README.md`，记录 `npm install --include=optional` 和 `CLAUDE_CODE_EXECUTABLE` 配置方式。

验证：
- `node scripts/check.mjs` 通过。
- 确认 `/Users/hackfqh/.local/bin/claude` 具备可执行权限。

已知后续：
- 仍需要用户本机 Claude Code 已完成认证；本修复只解决 CLI binary 查找问题。
