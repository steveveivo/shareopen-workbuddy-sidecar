#!/usr/bin/env node
/**
 * ShareOpen x WorkBuddy (CodeBuddy) — local WS sidecar (P2, route-B 2026-09-30).
 *
 * WorkBuddy/CodeBuddy runs on the USER machine. ShareOpen cloud cannot reach
 * their LAN, so we use the outbound pattern (same as P2 claude-code / codex):
 * the sidecar runs where CodeBuddy lives and connects OUT to ShareOpen over
 * WS.
 *
 *   ShareOpen  <—WS—>  sidecar  <—headless—>  codebuddy -p <prompt>
 *
 * Inbound: user message arrives on the WS, the sidecar spawns
 *   codebuddy -p <prompt> --output-format json
 * (CodeBuddy CLI headless mode; flags mirror claude code, -y skips
 * interactive confirms) and pushes the result back into the ShareOpen
 * conversation.
 *
 * Context: CodeBuddy keeps session jsonl under ~/.codebuddy/projects; the
 * sidecar passes --resume <session_id> so follow-up turns keep working
 * context within the same ShareOpen conversation.
 *
 * Usage:
 *   node index.js serve --agent-id <id> --token <so_live_...>
 *     [--shareopen <url> --workdir <dir> --codebuddy-bin <path>]
 *
 * Requirements on the user machine:
 *   1. CodeBuddy CLI installed & logged in (codebuddy on PATH, or CODEBUDDY_BIN)
 *   2. This sidecar running; without it the agent is offline and messages
 *      queue in the backend (existing /ws/agent behavior).
 */

import { ShareOpenConnector } from './sdk/index.js'
import { handleCommand, registerBuiltins } from './builtin-commands.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const cmd = process.argv[2]
const args = parseArgs(process.argv.slice(3))

const agentId = args['agent-id'] || process.env.WB_AGENT_ID || ''
const soToken = args.token || process.env.SO_AGENT_TOKEN || ''
const shareopen = args.shareopen || process.env.SHAREOPEN_URL || 'http://localhost:3021'
const workdir = args['workdir'] || process.cwd()
const WB_APP_CLI = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli'
// Bin resolution (2026-09-30): the native standalone CLI (`codebuddy install`,
// → ~/.local/bin/codebuddy, OAuth login) is the supported path; fall back to
// the GUI app's headless bundle for users who only installed the desktop app.
const codebuddyBin =
  args['codebuddy-bin'] ||
  process.env.CODEBUDDY_BIN ||
  (process.env.PATH.split(':').some((p) => existsSync(`${p}/codebuddy`))
    ? 'codebuddy'
    : `${WB_APP_CLI}/dist/codebuddy-headless.js`)

// Per-conversation CodeBuddy session id, so follow-up turns keep context.
// Persisted to disk: sidecar restarts (laptop sleep, crash, redeploy) must NOT
// drop conversation context — an in-memory-only map lost resume on every
// restart (verified in real e2e 2026-09-30: turn 2 'has no memory of prior
// turn' after a sidecar bounce).
import { readFileSync } from 'node:fs'
const SESSION_STORE = process.env.WB_SESSION_STORE || `${process.env.HOME || '.'}/.shareopen/workbuddy-sessions.json`
const SESSION_BY_CONV = new Map()
try {
  const raw = JSON.parse(readFileSync(SESSION_STORE, 'utf8'))
  for (const [k, v] of Object.entries(raw)) SESSION_BY_CONV.set(k, v)
} catch { /* first run — no store yet */ }
function persistSessions() {
  try {
    mkdirSync(SESSION_STORE.split('/').slice(0, -1).join('/'), { recursive: true })
    writeFileSync(SESSION_STORE, JSON.stringify(Object.fromEntries(SESSION_BY_CONV)))
  } catch (e) { console.warn('[workbuddy-sidecar] session persist failed:', e.message) }
}

// ── serve mode: WS sidecar ─────────────────────────────────────────────

async function serve() {
  // Token alone identifies the agent (the backend resolves it via
  // /ws/agent?token=…); --agent-id is an optional log label only.
  if (!soToken) {
    fail('serve requires --token (or WB_AGENT_ID host env not needed; token identifies the agent)')
  }

  const sdk = new ShareOpenConnector({
    transport: 'ws',
    host: shareopen,
    token: soToken,
  })

  await sdk.connect()
  console.log(`[workbuddy-sidecar] WS connected → ${shareopen} (agent ${agentId})`)

  // / command menu: register built-in slash commands + handle invocations.
  registerBuiltins(sdk, {
    agentName: 'WorkBuddy',
    binLabel: 'CodeBuddy CLI',
    workdir,
    describeSelf: async () => {
      try {
        const { execFile } = await import('node:child_process')
        const v = await new Promise((res) => execFile(codebuddyBin, ['--version'], (e, so) => res(so || '')))
        return `codebuddy ${String(v).trim().split('\n')[0]}`
      } catch { return '未知' }
    },
  })
  sdk.on('command', (inv) => handleCommand(inv, sdk, {
    agentName: 'WorkBuddy', binLabel: 'CodeBuddy CLI', workdir,
  }))

  sdk.on('message', async (msg) => {
    // Unified payload (SDK normalizes the backend's nested {type:'message',
    // data:{...}} frame — see sdk/node _dispatch 'message' case).
    const convId = msg.conversation_id
    const text = msg.text || ''
    const media = msg.media || null
    const group = msg.group || null   // [P0 2026-11-03] 群信封块
    if (!convId) {
      console.log(`[workbuddy-sidecar] frame without conversation_id, skip: ${JSON.stringify(msg).slice(0, 120)}`)
      return
    }
    if (!text && !media) {
      console.log(`[workbuddy-sidecar] empty text in ${convId}; no media; skip`)
      return
    }

    // Download media attachments to local temp files for the CLI to read.
    // CodeBuddy (like Claude Code) reads local files via its Read tool;
    // remote URLs are not directly accessible in the sandbox.
    let mediaDir = null
    let localAttachments = []
    if (media) {
      const staged = await stageAttachments(media, workdir)
      localAttachments = staged.paths
      mediaDir = staged.dir
    }

    const prompt = buildPrompt(text, localAttachments, group)
    console.log(`[workbuddy-sidecar] user msg in ${convId}: ${prompt.slice(0, 60)}…`)

    await sdk.typing(convId, true)
    const result = await runCodebuddyHeadless(prompt, workdir, convId, SESSION_BY_CONV.get(convId))
    await sdk.typing(convId, false)
    if (mediaDir) { try { await rm(mediaDir, { recursive: true, force: true }) } catch {} }

    if (result.error) {
      await sdk.send(convId, `[workbuddy error] ${result.error}`)
    } else {
      await sdk.send(convId, result.text || '(no output)')
    }
  })

  sdk.on('close', (code) => {
    console.warn(`[workbuddy-sidecar] WS closed (${code}); auto-reconnect in 5s`)
  })

  // Keep process alive.
  process.on('SIGINT', async () => {
    console.log('\n[workbuddy-sidecar] shutting down…')
    await sdk.disconnect()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    await sdk.disconnect()
    process.exit(0)
  })
}

/**
 * Run `codebuddy -p <prompt>` headlessly and capture the JSON output.
 * Returns { text, sessionId?, error? }.
 */
function runCodebuddyHeadless(prompt, cwd, convId, resumeSession) {
  const outArgs = ['-p', prompt, '--output-format', 'json', '-y']
  if (resumeSession) outArgs.push('--resume', resumeSession)
  console.log(`[workbuddy-sidecar] spawn codebuddy (resume=${resumeSession || 'none'})`)

  return new Promise((resolve) => {
    const proc = spawn(codebuddyBin, outArgs, {
      cwd,
      env: process.env,
      // [fix 2026-10-01] 同 claude 侧车: 关 stdin, 避免 codebuddy 卡在
      // "waiting for stdin" 3s 后静默降级 / 无输出.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ error: stderr.slice(0, 500) || `codebuddy exited ${code}` })
      }
      // [fix 2026-10-01] --resume 失效时 codebuddy 静默降级: exit 0, stdout 空,
      // stderr 提示 "No conversation found with session ID" (session 过期/丢失).
      // 旧代码只查 code, 空 stdout 被当正常输出 → 推送 '(no output)' 空气泡.
      // 现在: stdout 空/非 JSON 且 stderr 有内容 → 当错误上抛 (让调用方重发新会话).
      if (!String(stdout || '').trim()) {
        if (String(stderr || '').trim()) {
          console.warn(`[workbuddy-sidecar] codebuddy empty stdout on resume=${resumeSession}: ${stderr.slice(0,200)}`)
          return resolve({ error: `codebuddy resume failed (${resumeSession}): ${String(stderr).slice(0,300)}` })
        }
        // 真的空输出 (罕见, 非 resume 问题) → 明确报出而非空气泡
        return resolve({ error: 'codebuddy produced no output' })
      }
      try {
        const parsed = JSON.parse(stdout)
        // CodeBuddy output contract (v2.160+, verified 2026-09-30):
        // --output-format json returns a MESSAGE ARRAY; the terminal element
        // carries { subtype:'success', is_error, result, session_id }.
        // Older builds returned a flat { result, session_id } object.
        const term = Array.isArray(parsed)
          ? [...parsed].reverse().find((m) => m && m.result !== undefined)
          : parsed
        if (term?.session_id && convId) { SESSION_BY_CONV.set(convId, term.session_id); persistSessions() }
        if (term?.is_error) {
          return resolve({ error: String(term.result || 'codebuddy reported an error').slice(0, 500) })
        }
        // [fix 2026-10-01] resume 成功但 terminal.result 为 undefined (e.g. 会话
        // 状态异常/截断): 旧代码回退到整段 stdout (JSON 原文) 当答案推送.
        if (term?.result === undefined || term?.result === null) {
          console.warn(`[workbuddy-sidecar] terminal result missing (resume=${resumeSession}), clearing stale session`)
          SESSION_BY_CONV.delete(convId)
          persistSessions()
          return resolve({ error: 'codebuddy returned no final answer (stale session); please retry in a fresh conversation' })
        }
        resolve({ text: String(term.result) })
      } catch (e) {
        // [fix 2026-10-01] stdout 非 JSON (codebuddy 输出异常): 旧代码把整段
        // stdout 原文当答案推. 现在: 若疑似 resume 静默降级, 上抛错误.
        console.warn(`[workbuddy-sidecar] JSON parse failed: ${e.message}; stdout head: ${String(stdout).slice(0,150)}`)
        resolve({ text: String(stdout) })
      }
    })

    proc.on('error', (e) => resolve({ error: e.message }))
    setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        resolve({ error: 'codebuddy timed out after 5min' })
      }
    }, 5 * 60 * 1000)
  })
}

/**
 * Build the prompt for `codebuddy -p`, folding in local attachment paths so
 * the model can Read them with its built-in tools.
 */
function buildPrompt(text, localAttachments, group = null) {
  const parts = []
  // [P0 2026-11-03] 群上下文: 置顶渲染"我是谁(角色) / 群成员 / 最近发言 / 谁@了我".
  // 单聊 group=null → 零成本.
  if (group && group.members && group.members.length) {
    const roleLine = group.self_role ? `\n[你在本群的角色: ${group.self_role}]` : ''
    const members = group.members
      .filter(m => m && m.name)
      .map(m => `- ${m.name} (${m.type === 'agent' ? 'agent' : 'human'}${m.role ? `, 角色: ${m.role}` : ''})`)
      .join('\n')
    const recent = (group.recent || [])
      .filter(r => r && r.text && r.text.trim())
      .slice(-10)
      .map(r => `[${r.type === 'agent' ? 'agent' : 'user'} ${r.from}]: ${(r.text || '').slice(0, 300)}`)
      .join('\n')
    const mentioned = (group.mentions || []).filter(m => m && m.name).map(m => m.name)
    const mentionNote = mentioned.length ? `\n[本条消息 @了你: ${mentioned.join(', ')}]` : ''
    parts.push(
      `[Group context — 你在一个 ShareOpen 群聊里]${roleLine}\n` +
      `群成员:\n${members}\n` +
      (recent ? `最近发言:\n${recent}\n` : '') +
      mentionNote
    )
  }
  if (text) parts.push(text)
  if (localAttachments.length) {
    const lines = localAttachments.map(a =>
      `- ${a.path} (source name: ${a.name}${a.type ? `, type: ${a.type}` : ''})`
    )
    parts.push(
      `\n[Attached files — read them with the Read tool before answering]\n${lines.join('\n')}`
    )
    if (!text) parts.push('Please analyze the attached file(s).')
  }
  return parts.join('\n')
}

/**
 * Download media attachments into a per-message staging dir inside the
 * project dir so the CLI's file tools can read them (CLIs can't fetch
 * remote URLs).  Files land in `.so-media/<uuid>/`; caller cleans up.
 */
async function stageAttachments(media, workdir) {
  const dir = join(workdir, '.so-media', randomUUID().slice(0, 12))
  mkdirSync(dir, { recursive: true })
  const out = []
  const items = Array.isArray(media) ? media : [media]
  for (const att of items) {
    const url = att?.url || att?.media_url
    if (!url) continue
    const fname = (att.file_name || url.split('/').pop() || 'attachment').replace(/[^\w.\-]/g, '_')
    const localPath = join(dir, fname)
    try {
      const res = await fetch(url)
      if (!res.ok) { console.warn(`[workbuddy-sidecar] media download ${res.status}: ${url.slice(0, 80)}`); continue }
      writeFileSync(localPath, Buffer.from(await res.arrayBuffer()))
      out.push({ path: localPath, name: fname, type: att.type || att.media_type || '' })
      console.log(`[workbuddy-sidecar] media staged: ${localPath}`)
    } catch (e) {
      console.warn(`[workbuddy-sidecar] media download failed: ${e.message}`)
    }
  }
  return { paths: out, dir }
}

// ── shared ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    }
  }
  return out
}

function fail(msg) {
  console.error(`[workbuddy-sidecar] ${msg}`)
  process.exit(1)
}

switch (cmd) {
  case 'serve':
    serve().catch((e) => fail(e.message))
    break
  default:
    console.log('Usage:')
    console.log('  node index.js serve --agent-id <id> --token <so_live_...> [--shareopen <url> --workdir <dir> --codebuddy-bin <path>]')
    console.log('')
    console.log('  Runs the local WorkBuddy sidecar: needs the `codebuddy` CLI on this')
    console.log('  machine (installed & logged in), then stays connected to ShareOpen.')
}
