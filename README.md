# OceanKing

OceanKing 是一个以房间为公开协作事实、以 Agent 为跨房间持续执行主体的本地多 Agent 工作台。

## 启动

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

打开 `http://127.0.0.1:3000`。未配置 `OPENAI_API_KEY` 时自动使用确定性假模型，仍可完整体验调度、Console、Cron 和房间工具。

每个运行中的 OceanKing 后端必须使用独立的 `OCEANKING_DATA_DIR`。SQLite 是权威状态，但 SSE 事件总线和房间调度器属于当前进程；两个工作树共享同一数据目录会导致公开流式气泡丢失、调度状态分裂和版本冲突，因此第二个后端会拒绝占用已经使用中的目录。同时启动多个工作树时，请在各自终端中显式指定不同目录，例如：

```powershell
$env:OCEANKING_DATA_DIR = Join-Path $PWD ".oceanking"
pnpm dev
```

相对目录会基于当前工作树解析，因此上述命令可让每个工作树拥有独立的 SQLite、上传和 Agent 工作区。

模型连接使用服务端环境变量：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_MODELS`、`OPENAI_API_FORMAT`、`OPENAI_THINKING_MODE` 与 `OPENAI_REASONING_EFFORT`。`OPENAI_MODELS` 是逗号分隔的全局可选模型列表；思考模式可设为 `provider_default`、`enabled` 或 `disabled`，思考强度支持 `high` 与 `max`。设置页选择的全局配置由所有 Agent、房间调度和 Cron 工作流共同读取。OpenAI 兼容服务使用 `thinking.type` 显式开关；官方 OpenAI 开启时按接口格式发送 `reasoning.effort` 或 `reasoning_effort`，禁用时不覆盖模型默认行为。

Agent 会话会完整持久化，不按固定轮数截断。每次模型请求前会计算当前上下文 Token；超过设置页的“上下文压缩阈值”时，先把完整上下文压缩为可续接摘要，再继续正式请求。默认阈值为 `100000`，可通过 `OCEANKING_CONTEXT_TOKEN_THRESHOLD` 设置初始值。

## 核心边界

- 模型普通文本只进入私有 Console，不自动显示在房间。
- Agent 必须调用 `send_message_to_room` 才能公开发言。
- Agent 调用 `create_room` 时会自动成为新房间 owner 并连接，可在同一原子操作中通过 `agentIds` 邀请多个可用 Agent。
- `send_message_to_room` 参数生成期间会通过 SSE 显示临时流式气泡；只有工具成功后才写入正式消息，失败或停止时不会留下半截内容。
- 用户消息和 Agent 通过 `send_message_to_room` 提交的新消息具有相同的抢占权：消息写入后会立即中止目标 Agent 的旧 run，保存未完成快照，并由包含新旧消息的新 Turn 接管。
- 同一 Agent 的运行会话跨房间共享，同时只能有一个 active run。
- SQLite 是权威状态，SSE 与浏览器状态只是实时投影。

> 警告：按当前产品配置，Agent shell 继承启动进程的系统权限，可访问整个本机磁盘且不进行高危命令审批。仅在可信的本地环境中运行。
