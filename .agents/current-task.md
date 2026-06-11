## Added Requirement

Type: Feature implementation

Summary: 按顺序实现当前 Codex Mobile Companion 后续功能点，包括初始化修复、Claude 接入收尾、消息搜索、手机通知、Relay 持久化、多 Agent 适配层、PWA、安全增强、调试页面和自动化检查。

Scope And Constraints:
- 保持现有 Codex 功能可用，不破坏项目选择、历史消息、授权和实时同步。
- Claude 支持作为可选能力，SDK 缺失时要有清晰状态，不应影响 Codex。
- 尽量不引入额外运行时依赖；已经声明的 Claude SDK 只用于 Claude Agent。
- 自用局域网场景优先，安全增强以 token 和会话机制为主。

Acceptance Criteria:
- Web 端不再因为 `agentStorageKey` 初始化顺序报错。
- README 和启动说明与 Claude SDK 依赖保持一致。
- 项目、历史、消息视图支持本地搜索过滤。
- 浏览器支持时可以开启回复完成和待授权通知。
- Relay 重启后能恢复最近事件、线程和待处理授权。
- Host Agent 具有清晰的 Agent adapter 分发入口，Codex 和 Claude 逻辑互不影响。
- Web 端具备基本 PWA 能力和调试视图。
- 提供调试接口和基本检查脚本验证。

## Added Requirement

Type: Product completion

Summary: 在已有手机伴侣基础上继续按顺序实现更完整的产品功能，包括 Claude 依赖锁定、会话管理、消息渲染增强、授权安全、多设备 session 管理、Agent/项目设置、多 Agent 辅助发送、导出能力和必要的文档测试，直到当前版本达到相对完整可自用的产品状态。

Scope And Constraints:
- 继续保持 Codex 主路径稳定，Claude 仍作为可选能力。
- 会话管理可以先用 Relay 本地元数据实现，不要求反向修改 Codex/Claude 原始历史。
- 安全功能以默认保守为主，不能默认绕过用户授权。
- 前端保持移动端优先，避免复杂依赖。

Acceptance Criteria:
- 生成并维护 npm 依赖锁文件，或者明确记录无法联网安装的原因。
- 手机端支持新建对话、重命名、置顶、归档和导出当前对话。
- 消息支持基本 Markdown、代码块、diff 样式和复制操作。
- 授权卡片能展示风险等级，并对高风险操作做额外确认。
- 调试/设置界面能查看并撤销浏览器 session。
- 支持项目级默认 Agent 设置，以及把同一条消息发送到多个 Agent 的入口。
- README、检查脚本和 smoke test 覆盖新增核心能力。

## Added Requirement

Type: Packaging distribution

Summary: 将当前项目补成可安装的本地 CLI 工具，允许用户通过单个命令在任意项目目录启动 Companion，而不需要直接手动拼脚本路径或额外的 doctor 检查命令。

Scope And Constraints:
- 保持现有 `npm start` 可用，同时增加可执行命令入口。
- 启动逻辑需要对安装位置不敏感，能够从包内定位 Relay、Host 和静态资源。
- 不新增 doctor 命令；启动时失败即可给出清晰报错和帮助信息。

Acceptance Criteria:
- 项目具备 `bin` 入口，可通过 CLI 一键启动。
- 启动脚本在包内/全局安装场景下都能找到自身资源。
- README 补充本地安装与命令执行方式。
