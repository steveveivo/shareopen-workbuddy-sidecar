# ShareOpen × WorkBuddy 连接器（P2 路线②，2026-09-30）

> 状态：P2（本地侧车）。协议见 `sdk/PROTOCOL.md`。

WorkBuddy（腾讯 CodeBuddy）跑在**用户自己的电脑**上。ShareOpen 云端
触不到用户局域网，所以走**出站模式**（与 P2 claude-code / codex 同款）：

```
ShareOpen  ←—WS—→  sidecar（用户机器）  ←—headless—→  codebuddy -p
```

- **入站**：用户消息经 `/ws/agent` 到 sidecar，sidecar spawn
  `codebuddy -p <prompt> --output-format json -y`，把结果推回 ShareOpen 会话。
- **上下文**：CodeBuddy 把会话存 `~/.codebuddy/projects/{id}/{sessionId}.jsonl`；
  sidecar 传 `--resume <sessionId>`，同一 ShareOpen 会话的后续消息延续上下文。

## 用户操作（三步）

1. **创建 agent**：ShareOpen「新增外部 Agent」选 WorkBuddy 类型，填名字 →
   得到连接 token（`so_live_...`）。
2. **本机装 CodeBuddy CLI 并登录**：`codebuddy` 命令可用。
3. **启动侧车**：
   ```bash
   node connectors/workbuddy/index.js serve \
     --agent-id <workbuddy_xxx> --token <so_live_...> \
     --shareopen https://shareopen.com [--workdir <你的工作目录>]
   ```
   侧车上线后 agent 状态变「在线」，即可在 ShareOpen 里直接发消息。

## 安装脚本

`install.sh` 把本目录拷到 `~/.shareopen/connectors/workbuddy`（需本机已
`npm install` 根目录依赖，侧车复用 `sdk/node` 的 WS transport）。

## 已知边界
- 电脑关机 / 侧车未跑 = agent 离线；消息由后端 `/ws/agent` 既有机制排队，
  侧车重连后自动补发。
- 附件：sidecar 把文件名/描述内联进 prompt（用户局域网对 CodeBuddy 不可达，
  不回传二进制）。
- 单轮 5min 超时强杀（与 claude/codex 侧车一致）。

## 与旧 P1.5 云端 relay 的关系（已下线）
`backend/lib/workbuddy-replay.js` 的「Cloud Task API + ACP SSE」云转发
路径**基于未公开 API，已废弃**。WorkBuddy 无公开云端 Task API（查 workbuddy.ai
国际版文档确认）；实际可用的公开接口是本地 `codebuddy --serve` HTTP API，
与本侧车的 headless CLI 模式等价。messaging.js 的 `gateway_type='workbuddy'`
出站分支已移除；WorkBuddy agent 现以 `gateway_type='hermes_ws'` 建库，走
`/ws/agent` 出站路径。
