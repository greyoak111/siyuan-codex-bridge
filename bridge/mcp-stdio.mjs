#!/usr/bin/env node
/**
 * dsh-siyuan — STDIO ↔ Streamable-HTTP MCP bridge for SiYuan (思源笔记).
 *
 * The DSH MCP client spawns this file and speaks newline-delimited JSON-RPC on
 * stdio. Every request is forwarded to the local SiYuan kernel's own MCP
 * endpoint, with the SiYuan API token added as an `Authorization: Token …`
 * header. Nothing here parses or rewrites `.sy` files or `siyuan.db`: the
 * official endpoint stays the only way notes are read or written.
 *
 * Two things this process owns, and nothing else:
 *
 *   - the API token, resolved from the environment, a user config file, or
 *     SiYuan's own workspace configuration, and never printed or logged;
 *   - the operation profile, re-read from the environment and the config file on
 *     every `tools/call` and checked before forwarding, so "the model can see
 *     the tool" and "the action is allowed" stay separate decisions — and a
 *     level change takes effect on the next call, not on the next restart.
 *
 * State (config, audit log) lives under ~/.config/dsh-siyuan, never inside the
 * installed package directory, which the plugin installer treats as immutable.
 *
 * Run `mcp-stdio.mjs --doctor` for a diagnostic report that prints no secrets.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const DEFAULTS = {
  apiUrl: 'http://127.0.0.1:6806',
  profile: 'authoring',
}

const READ_ACTIONS = {
  search: ['fulltext', 'semantic'],
  document: ['get', 'list', 'search_docs', 'info'],
  block: ['get', 'get_kramdown', 'get_children', 'tree_stat', 'dom', 'breadcrumb', 'batch_get', 'batch_kramdown'],
  notebook: ['list'],
  outline: ['get'],
  ref: ['backlinks', 'mentions'],
  attr: ['get', 'batch-get'],
  system: ['version', 'current_time', 'workspace'],
  workspace: ['list', 'info'],
}

const AUTHORING_ACTIONS = {
  document: ['create'],
  block: ['insert', 'append', 'prepend', 'update'],
  attr: ['set', 'batch-set'],
  dailynote: ['create', 'append', 'prepend'],
}

const PROFILES = ['readonly', 'authoring', 'full']

const PROFILE_SUMMARY = {
  readonly: 'search and read notes only',
  authoring: 'read plus document/block content writes',
  full: 'the complete official SiYuan tool surface',
}

/** The user-owned state directory; nothing is written inside the package. */
function stateDir() {
  return process.env.DSH_SIYUAN_HOME || join(homedir(), '.config', 'dsh-siyuan')
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function normalizeProfile(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  const alias = { read: 'readonly', edit: 'authoring' }
  const profile = alias[raw] ?? raw
  return PROFILES.includes(profile) ? profile : undefined
}

/**
 * Resolve everything this bridge needs, keeping the token's origin for the
 * doctor report while never exposing the token itself.
 */
function resolveConfig() {
  const configFile = join(stateDir(), 'config.json')
  const file = readJsonFile(configFile) ?? {}
  const notes = []

  let token = ''
  let tokenSource = 'none'
  if (typeof process.env.SIYUAN_API_TOKEN === 'string' && process.env.SIYUAN_API_TOKEN.trim() !== '') {
    token = process.env.SIYUAN_API_TOKEN.trim()
    tokenSource = 'environment (SIYUAN_API_TOKEN)'
  } else if (typeof file.token === 'string' && file.token.trim() !== '') {
    token = file.token.trim()
    tokenSource = configFile
  } else {
    // SiYuan keeps the API token in the active workspace's conf/conf.json; the
    // workspace list is what makes this work without asking the user to paste
    // anything. A workspace may have no token configured yet.
    const siyuanConfDir = join(homedir(), '.config', 'siyuan')
    const workspaces = readJsonFile(join(siyuanConfDir, 'workspace.json'))
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      if (typeof workspace !== 'string') continue
      const confPath = join(workspace, 'conf', 'conf.json')
      const candidate = readJsonFile(confPath)?.api?.token
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        token = candidate.trim()
        tokenSource = confPath
        break
      }
    }
  }

  const apiUrl = String(
    file.apiUrl
      ?? process.env.SIYUAN_API_URL
      ?? DEFAULTS.apiUrl,
  ).replace(/\/+$/u, '')
  const mcpUrl = String(
    file.mcpUrl
      ?? process.env.SIYUAN_MCP_URL
      ?? `${apiUrl}/mcp`,
  )

  const profile = normalizeProfile(file.profile)
    ?? normalizeProfile(process.env.SIYUAN_MCP_PROFILE)
    ?? DEFAULTS.profile
  if (file.profile !== undefined && normalizeProfile(file.profile) === undefined) {
    notes.push(`ignored invalid profile "${file.profile}" in ${configFile}`)
  }

  return { apiUrl, configFile, mcpUrl, notes, profile, token, tokenSource }
}

/**
 * The operation profile to decide one call with.
 *
 * Deliberately re-read here rather than taken from {@link resolveConfig}: the
 * token and endpoint are process-lifetime facts, but the profile is a knob
 * users turn while the bridge is running. `siyuan-scope` (and any editor) writes
 * that key at any moment, so a level change frozen at startup would only take
 * effect after a restart — and the trap is silent, because the process keeps
 * answering with the level it booted on. The Python bridge this file replaced
 * re-read its policy file per call, so per-call is also the documented
 * behaviour rather than a new promise.
 *
 * Precedence is environment first, then the config file, then whatever startup
 * resolved. An explicit `SIYUAN_MCP_PROFILE` is a deployment-level statement and
 * must not be overruled by a stray key in a user config file. A malformed value
 * in either place falls through to the next source instead of guessing.
 */
function currentProfile(config) {
  return normalizeProfile(process.env.SIYUAN_MCP_PROFILE)
    ?? normalizeProfile(readJsonFile(config.configFile)?.profile)
    ?? config.profile
}

/** Keep a live token out of anything this process writes or prints. */
function redact(value, token) {
  if (!token) return value
  if (typeof value === 'string') return value.split(token).join('[redacted]')
  if (Array.isArray(value)) return value.map((item) => redact(item, token))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)]))
  }
  return value
}

function safeLabel(value, limit = 160) {
  return String(value).replace(/[\r\n]+/gu, ' ').slice(0, limit)
}

function actionAllowed(profile, tool, action) {
  if (profile === 'full') return true
  if (READ_ACTIONS[tool]?.includes(action)) return true
  return profile === 'authoring' && AUTHORING_ACTIONS[tool]?.includes(action) === true
}

/** A tool called without an `action` argument is not classifiable, so only `full` may run it. */
function callAllowed(profile, tool, args) {
  const action = args?.action
  if (action === undefined) return profile === 'full'
  return actionAllowed(profile, tool, String(action))
}

function audit(profile, tool, action, decision) {
  try {
    const dir = stateDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, 'audit.jsonl')
    // Deliberately without arguments, note content, headers or the token.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      client: 'dsh-siyuan',
      profile,
      tool: safeLabel(tool, 64),
      action: safeLabel(action ?? '', 64),
      decision,
    })
    appendFileSync(path, `${line}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // Auditing must never break a call it just authorized.
  }
}

/** Streamable HTTP servers may answer either as JSON or as a one-event SSE stream. */
function decodeBody(text, contentType) {
  const looksLikeSse = contentType.includes('text/event-stream')
    || text.trimStart().startsWith('event:')
    || text.trimStart().startsWith('data:')
  if (!looksLikeSse) return text
  const data = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((chunk) => chunk !== '' && chunk !== '[DONE]')
  return data.length > 0 ? data[data.length - 1] : '{}'
}

function jsonRpcError(id, message, code = -32002) {
  const payload = { jsonrpc: '2.0', error: { code, message } }
  if (id !== undefined) payload.id = id
  return payload
}

function requestIdFromLine(raw) {
  try {
    return JSON.parse(raw.trim())?.id
  } catch {
    return undefined
  }
}

/** One bridge process serves one MCP session; SiYuan hands back its session id on initialize. */
function createUpstream(config) {
  let sessionId = undefined

  return async function forward(message) {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    }
    if (config.token) headers.Authorization = `Token ${config.token}`
    if (sessionId !== undefined) headers['Mcp-Session-Id'] = sessionId

    let response
    try {
      response = await fetch(config.mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      })
    } catch {
      // The URL is safe to name; the connection error may echo headers.
      return jsonRpcError(message.id, `SiYuan is not reachable at ${config.mcpUrl}. Start the SiYuan desktop app and try again.`)
    }

    const returned = response.headers.get('mcp-session-id')
    if (returned) sessionId = returned

    if (!response.ok) {
      // Never surface the body: an error page can carry server internals.
      if (response.status === 401 || response.status === 403) {
        return jsonRpcError(message.id, 'SiYuan rejected the API token. Check the token in SiYuan → Settings → About, or set it in ~/.config/dsh-siyuan/config.json.', -32003)
      }
      return jsonRpcError(message.id, `SiYuan MCP answered HTTP ${response.status}.`)
    }

    const text = await response.text()
    if (text.trim() === '') return undefined
    try {
      return redact(JSON.parse(decodeBody(text, response.headers.get('content-type') ?? '')), config.token)
    } catch {
      return jsonRpcError(message.id, 'SiYuan returned a response this bridge could not parse.')
    }
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function doctor(config) {
  const report = [
    `state directory: ${stateDir()}`,
    `config file: ${config.configFile}${readJsonFile(config.configFile) === undefined ? ' (absent)' : ''}`,
    `endpoint: ${config.mcpUrl}`,
    `token: ${config.token ? `present (from ${config.tokenSource})` : 'MISSING — set it in the config file or in SiYuan itself'}`,
    `operation profile: ${currentProfile(config)} (${PROFILE_SUMMARY[currentProfile(config)]})`,
    ...config.notes.map((note) => `note: ${note}`),
  ]
  for (const line of report) process.stdout.write(`${line}\n`)

  if (!config.token) return 2
  const forward = createUpstream(config)
  const initialized = await forward({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-siyuan-doctor', version: '1.0' } },
  })
  if (initialized?.error) {
    process.stdout.write(`initialize: FAILED — ${initialized.error.message}\n`)
    return 3
  }
  const serverInfo = initialized?.result?.serverInfo
  process.stdout.write(`initialize: ok (${serverInfo?.name ?? 'unknown'} ${serverInfo?.version ?? ''})\n`)
  const listed = await forward({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  if (listed?.error) {
    process.stdout.write(`tools/list: FAILED — ${listed.error.message}\n`)
    return 3
  }
  process.stdout.write(`tools/list: ok (${listed?.result?.tools?.length ?? 0} tools)\n`)
  return 0
}

async function main() {
  const config = resolveConfig()

  if (process.argv.includes('--doctor')) {
    process.exitCode = await doctor(config)
    return
  }

  const forward = createUpstream(config)

  // Without a token every request answers with one actionable error instead of
  // a connection failure, so the reason reaches the model rather than the log.
  const missingToken = 'No SiYuan API token found. Open SiYuan → Settings → About and copy the API token, then either '
    + `save it as {"token": "…"} in ${config.configFile} or leave it in SiYuan's own settings and restart SiYuan so the bridge can read it.`

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  // Keep one promise chain for the whole stdio stream. The upstream calls are
  // asynchronous; starting them independently lets a later, faster request
  // write its response before an earlier, slower one. MCP clients generally
  // tolerate out-of-order ids, but DSH's line-oriented transport and logs are
  // much easier to reason about when responses retain arrival order.
  let queue = Promise.resolve()

  /** Requests are answered in arrival order; a slow call must not reorder the stream. */
  const run = async (raw) => {
    const trimmed = raw.trim()
    if (trimmed === '') return

    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      write(jsonRpcError(undefined, 'invalid JSON request', -32700))
      return
    }

    // One guard for the whole surface: every request answers with the same
    // actionable reason while no token is configured.
    if (!config.token) {
      if (message.id !== undefined) write(jsonRpcError(message.id, missingToken, -32003))
      return
    }

    if (message.method === 'tools/call') {
      const tool = String(message.params?.name ?? '')
      const args = message.params?.arguments ?? {}
      // One profile for this call's decision, its audit line and its error text:
      // read once here so a level change mid-call cannot make them disagree.
      const profile = currentProfile(config)
      if (!callAllowed(profile, tool, args)) {
        audit(profile, tool, args?.action, 'denied')
        write(jsonRpcError(
          message.id,
          `tool ${JSON.stringify(safeLabel(tool, 64))} action ${JSON.stringify(safeLabel(args?.action ?? '', 64))} is denied by the dsh-siyuan operation profile "${profile}"`,
          -32003,
        ))
        return
      }
      audit(profile, tool, args?.action, 'allowed')
    } else if (message.method === 'ping') {
      write({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }

    const answer = await forward(message)
    // Notifications carry no id and get no response.
    if (message.id !== undefined && answer !== undefined) write(answer)
  }

  lines.on('line', (raw) => {
    // Keep the id alongside this queued item so an unexpected exception can
    // fail the matching JSON-RPC call immediately instead of causing a timeout.
    const requestId = requestIdFromLine(raw)
    queue = queue
      .then(() => run(raw))
      .catch((error) => {
        // Keep the chain alive after an unexpected per-request failure so one
        // malformed upstream response cannot strand all following requests.
        write(jsonRpcError(requestId, 'request failed: ' + safeLabel(error?.message ?? error), -32000))
      })
  })

  await new Promise((resolve) => lines.on('close', resolve))
  await queue
}

main().catch((error) => {
  write(jsonRpcError(undefined, `dsh-siyuan bridge failed: ${safeLabel(error?.message ?? error)}`, -32000))
  process.exitCode = 1
})
