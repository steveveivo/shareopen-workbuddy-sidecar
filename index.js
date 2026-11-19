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

import { ShareOpenConnector } from '../../sdk/node/index.js'
import { handleCommand, registerBuiltins } from '../builtin-commands.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const cmd = process.argv[2]
const args = parseArgs(process.argv.slice(3))

const agentId = args['agent-id'] || process.env.WB_AGENT_ID || ''
const soToken = args.token || process.env.SO_AGENT_TOKEN || ''
const shareopen = args.shareopen || process.env.SHAREOPEN_URL || 'http://localhost:3021'
const workdir = args['workdir'] || join(process.env.HOME || '', '.workbuddy') // [2026-11-18] 默认指向 WorkBuddy 底座目录, 不用 shareopen connector 文件夹
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
    // [align 2026-11-17] 工具执行进度 → progress_update 帧 (对齐 codex/claude 进度条)
    const onProgress = (tool) => {
      console.log(`[workbuddy-sidecar] progress ${convId}: tool ${tool}`)
      sdk.progress(convId, `[workbuddy] 执行 ${tool || '工具'}`, 'in_progress').catch(() => {})
    }
    const result = await runCodebuddyHeadless(prompt, workdir, convId, SESSION_BY_CONV.get(convId), onProgress)
    await sdk.typing(convId, false)
    if (mediaDir) { try { await rm(mediaDir, { recursive: true, force: true }) } catch {} }

    if (result.error) {
      await sdk.send(convId, `[workbuddy error] ${result.error}`)
    } else if (result.chunks) {
      // [P0 2026-11-16] 真流式: 文本增量经生成器流式推送 (打字机效果),
      // sdk.stream 内部收尾为 final agent_message. 无出站附件, 纯文本安全.
      await sdk.stream(convId, result.chunks, { finalFallback: result.text || '(no output)' })
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
function runCodebuddyHeadless(prompt, cwd, convId, resumeSession, onProgress) {
  const outArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '-y']
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
    // [P0 2026-11-16] 真流式: 累积 stream-json 文本增量 → chunks 队列;
    // 同时抓 session_id (从 result/session 事件) 供 resume 复用.
    const chunkQueue = []
    let chunkWaiter = null
    let done = false
    const fullText = { v: '' }
    let capturedSessionId = null
    const PACE_CHARS = 5
    const PACE_MS = 50
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // [P0 2026-11-17 fix] 打字机节奏放消费侧(yield 间 sleep), 生产侧只入队+唤醒
    const enqueue = (t) => {
      if (!t) return
      fullText.v += t
      chunkQueue.push(t)
      if (chunkWaiter) { const w = chunkWaiter; chunkWaiter = null; w() }
    }
    proc.stdout.on('data', (d) => {
      stdout += d
      const lines = stdout.split('\n')
      stdout = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line)
          if (ev.session_id) capturedSessionId = ev.session_id
          // CodeBuddy stream-json: assistant 文本增量
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c && c.type === 'text' && c.text) enqueue(c.text)
              // [align 2026-11-17] tool_use 事件 → 进度帧 (对齐 codex/claude):
              else if (c && c.type === 'tool_use') onProgress?.(c.name)
            }
          } else if (ev.type === 'result' && ev.result !== undefined && ev.result !== null) {
            if (!fullText.v) enqueue(String(ev.result))
            if (ev.is_error) return
            if (ev.session_id) capturedSessionId = ev.session_id
          }
        } catch (_) {}
      }
    })
    proc.stderr.on('data', (d) => (stderr += d))

    proc.on('close', async (code) => {
      if (code !== 0) {
        return resolve({ error: stderr.slice(0, 500) || `codebuddy exited ${code}` })
      }
      // [P0 2026-11-16] session_id 从流式事件抓; 兜底从 close 后全量 stdout (JSONL 拼回) 再试.
      let sessionId = capturedSessionId
      if (!sessionId && String(stdout || '').trim()) {
        try {
          const parsed = JSON.parse(stdout)
          const term = Array.isArray(parsed) ? [...parsed].reverse().find((m) => m && m.result !== undefined) : parsed
          sessionId = term?.session_id || null
        } catch (_) {
          // stream-json: stdout 是多行 JSONL, 逐行找 session_id
          for (const l of String(stdout).split('\n')) {
            if (!l.trim()) continue
            try { const o = JSON.parse(l); if (o.session_id) { sessionId = o.session_id; break } } catch (_) {}
          }
        }
      }
      if (sessionId && convId) { SESSION_BY_CONV.set(convId, sessionId); persistSessions() }

      // [fix 2026-10-01] --resume 失效静默降级 / 空输出 兜底 (保留原逻辑).
      // [P0 2026-11-17] 真降级: resume 失效(空输出)时, 去掉 --resume 重跑一次(无上下文首轮),
      //   而不是直接报 produced no output. 仅当"无 resume 重跑"后仍空, 才报错.
      if (!String(fullText.v || '').trim() && !String(stdout || '').trim()) {
        if (resumeSession) {
          console.warn(`[workbuddy-sidecar] resume=${resumeSession} produced no output → retry without --resume`)
          SESSION_BY_CONV.delete(convId)
          persistSessions()
          const retry = await runCodebuddyHeadless(prompt, cwd, convId, null, onProgress)
          return resolve(retry)
        }
        if (String(stderr || '').trim()) {
          console.warn(`[workbuddy-sidecar] codebuddy empty stdout on resume=${resumeSession}: ${stderr.slice(0,200)}`)
          return resolve({ error: `codebuddy resume failed (${resumeSession}): ${String(stderr).slice(0,300)}` })
        }
        return resolve({ error: 'codebuddy produced no output' })
      }

      done = true
      if (chunkWaiter) { const w = chunkWaiter; chunkWaiter = null; w() }
      const chunks = (async function* () {
        let i = 0
        while (i < chunkQueue.length || !done) {
          while (i < chunkQueue.length) {
            const t = chunkQueue[i++]
            for (let p = 0; p < t.length; p += PACE_CHARS) {
              yield t.slice(p, p + PACE_CHARS)
              if (p + PACE_CHARS < t.length) await sleep(PACE_MS)
            }
          }
          if (!done) await new Promise((r) => { chunkWaiter = r })
        }
      })()
      resolve({ text: fullText.v || String(stdout), chunks })
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
