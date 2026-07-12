# OceanKing

OceanKing 是一个以房间为公开协作事实、以 Agent 为跨房间持续执行主体的本地多 Agent 工作台。

## 启动

```powershell
pnpm install
Copy-Item .env.example .env.local
pnpm dev
```

打开 `http://127.0.0.1:3000`。未配置 `OPENAI_API_KEY` 时自动使用确定性假模型，仍可完整体验调度、Console、Cron 和房间工具。

模型连接使用服务端环境变量：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_MODELS` 与 `OPENAI_API_FORMAT`。`OPENAI_MODELS` 是逗号分隔的全局可选模型列表；设置页选择的默认模型由所有 Agent、房间调度和 Cron 工作流共同读取。

## 核心边界

- 模型普通文本只进入私有 Console，不自动显示在房间。
- Agent 必须调用 `send_message_to_room` 才能公开发言。
- 同一 Agent 的运行会话跨房间共享，同时只能有一个 active run。
- SQLite 是权威状态，SSE 与浏览器状态只是实时投影。

> 警告：按当前产品配置，Agent shell 继承启动进程的系统权限，可访问整个本机磁盘且不进行高危命令审批。仅在可信的本地环境中运行。
