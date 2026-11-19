#!/usr/bin/env bash
# ShareOpen x WorkBuddy 侧车 — 安装/启动脚本 (P2 route-B 2026-09-30).
# WorkBuddy 跑在本机，侧车出站连 ShareOpen；需要本机 codebuddy CLI 已装并登录。
set -euo pipefail

SHAREOPEN_URL="${SHAREOPEN_URL:-http://localhost:3021}"
AGENT_ID="${WB_AGENT_ID:?Set WB_AGENT_ID (ShareOpen WorkBuddy agent id, e.g. workbuddy_xxx)}"
SO_TOKEN="${SO_AGENT_TOKEN:?Set SO_AGENT_TOKEN (agent's so_live_... token; 见创建成功弹窗)}"
WORKDIR="${WORKDIR:-$(echo $HOME)/.workbuddy}" # [2026-11-18] 默认指向 WorkBuddy 底座目录, 跟 index.js 对齐

echo ">> 检查 codebuddy CLI..."
command -v codebuddy >/dev/null 2>&1 || { echo "错误: 'codebuddy' 不在 PATH。先安装并登录 CodeBuddy CLI。"; exit 1; }
echo "codebuddy: $(command -v codebuddy)"

HERE="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo ">> 启动侧车（前台运行；生产环境请套 tmux/systemd/launchd）:"
echo "   node $HERE/index.js serve \\"
echo "     --agent-id $AGENT_ID \\"
echo "     --token \$SO_TOKEN \\"
echo "     --shareopen $SHAREOPEN_URL \\"
echo "     --workdir $WORKDIR"
echo ""
echo ">> 侧车打印 'WS connected' 后，ShareOpen 里的 WorkBuddy agent 即在线。"
echo "   电脑关机 / 停掉侧车 = agent 离线，消息自动排队，重连后补发。"
