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
 * It starts no process and opens no window: the only thing it does outside its
 * own stdio is talk to that loopback endpoint. SiYuan is the user's app to
 * open, and a harness restarting is not a reason to launch it.
 *
 * Because SiYuan is a desktop app that gets closed, the bridge answers the MCP
 * handshake and `tools/list` itself: `initialize` goes upstream when the app is
 * there and is answered locally when it is not, and the tool catalog comes from
 * upstream when reachable, from this reader's own cache next, and from the
 * snapshot shipped in the package last — so a first run before SiYuan has ever
 * been opened still shows what the plugin can do.
 * A client registers a server's tools only if that first handshake succeeds and
 * never retries a server it could not reach, so without this a session started
 * while SiYuan was shut would silently lose its tools. Calls are the opposite:
 * they always go upstream, and while the app is closed they say so.
 *
 * Three things this process owns, and nothing else:
 *
 *   - the API token, resolved from the environment, a user config file, or
 *     SiYuan's own workspace configuration, and never printed or logged;
 *   - the session with SiYuan, re-established on demand: a call that meets a
 *     forgotten session re-handshakes and retries once, so quitting and
 *     reopening the app does not strand the bridge on a dead session id;
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

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const DEFAULTS = {
  apiUrl: 'http://127.0.0.1:6806',
  profile: 'authoring',
}

/** The version this bridge answers with when it has to speak for itself. */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

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

/**
 * The bridge's own identity for the local handshake, and the session it keeps
 * with SiYuan. SiYuan refuses `tools/call` before `initialize`
 * ("method \"tools/call\" is invalid during session initialization"), so a
 * session is a precondition for every forwarded request.
 */
function bridgeIdentity() {
  const pkg = readJsonFile(fileURLToPath(new URL('../package.json', import.meta.url)))
  return {
    name: typeof pkg?.name === 'string' ? pkg.name : 'dsh-siyuan',
    version: typeof pkg?.version === 'string' ? pkg.version : '0.0.0-unknown',
  }
}

function toolsCacheFile() {
  return join(stateDir(), 'tools-cache.json')
}

/** The last catalog this bridge actually saw, or undefined when it never saw one. */
function readToolsCache() {
  const cached = readJsonFile(toolsCacheFile())
  return Array.isArray(cached?.tools) && cached.tools.length > 0 ? cached : undefined
}

/**
 * The catalog shipped with the package.
 *
 * A session started before SiYuan has ever been reached — a fresh install, a
 * machine where the app has not been opened yet — would otherwise list no tools
 * at all, which reads as "this plugin does nothing" rather than "the app is
 * closed". The snapshot only ever fills that hole: a live catalog and the
 * reader's own cache both outrank it, and it is replaced the first time SiYuan
 * answers. Refresh it with `--dump-catalog`.
 */
function readToolsSnapshot() {
  const snapshot = readJsonFile(fileURLToPath(new URL('./tools-snapshot.json', import.meta.url)))
  return Array.isArray(snapshot?.tools) && snapshot.tools.length > 0 ? snapshot : undefined
}

/** Name where a served catalog came from, for the client's log and for the doctor. */
function describeCatalog(cached, snapshot) {
  if (cached !== undefined) return `cached ${cached.fetchedAt} while SiYuan was unreachable`
  if (snapshot !== undefined) {
    const from = snapshot.source?.name === undefined ? 'an earlier SiYuan' : `${snapshot.source.name} ${snapshot.source.version ?? ''}`.trim()
    return `built-in snapshot from ${from} (${snapshot.tools.length} tools), used until SiYuan answers once`
  }
  return 'SiYuan has not been reachable and no built-in snapshot is present'
}

function writeToolsCache(result) {
  if (!Array.isArray(result?.tools) || result.tools.length === 0) return
  const path = toolsCacheFile()
  const payload = { fetchedAt: new Date().toISOString(), tools: result.tools }
  try {
    if (JSON.stringify(readJsonFile(path)?.tools) === JSON.stringify(payload.tools)) return
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // A cache miss only costs a session started with no tools listed.
  }
}

/**
 * One bridge process keeps one session with SiYuan.
 *
 * `send` is the raw transport: it reports unreachability separately from a
 * protocol error so callers can decide between answering locally and failing.
 * `ensureSession` performs the handshake on demand — needed when the client's
 * own `initialize` was answered locally because SiYuan was closed at the time.
 */
function createUpstream(config) {
  let sessionId = undefined
  let handshaken = false

  async function send(message) {
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
      return { unreachable: `SiYuan is not reachable at ${config.mcpUrl}. Open the SiYuan desktop app and try again.` }
    }

    const returned = response.headers.get('mcp-session-id')
    if (returned) sessionId = returned

    if (!response.ok) {
      // Never surface the body: an error page can carry server internals.
      if (response.status === 401 || response.status === 403) {
        return { reply: jsonRpcError(message.id, 'SiYuan rejected the API token. Check the token in SiYuan → Settings → About, or set it in ~/.config/dsh-siyuan/config.json.', -32003) }
      }
      if (response.status === 404) {
        // SiYuan answers 404 for a session it no longer knows — including after
        // the app was restarted, which is a normal way for a desktop app's
        // session to end. The caller re-handshakes and retries once.
        return { sessionLost: true, reply: jsonRpcError(message.id, 'SiYuan no longer knows this MCP session.', -32002) }
      }
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'))
        const wait = Number.isFinite(retry) && retry > 0 ? ` Retry in about ${retry} seconds.` : ''
        return { reply: jsonRpcError(message.id, `SiYuan is rate-limiting its MCP endpoint (HTTP 429).${wait} Bursts of calls trip this; it clears on its own.`, -32002) }
      }
      return { reply: jsonRpcError(message.id, `SiYuan MCP answered HTTP ${response.status}.`) }
    }

    const text = await response.text()
    if (text.trim() === '') return { reply: undefined }
    try {
      return { reply: redact(JSON.parse(decodeBody(text, response.headers.get('content-type') ?? '')), config.token) }
    } catch {
      return { reply: jsonRpcError(message.id, 'SiYuan returned a response this bridge could not parse.') }
    }
  }

  /**
   * Establish the upstream session if there is not one yet. False means SiYuan
   * is away.
   *
   * Readiness is tracked apart from the session id: a Streamable HTTP server is
   * allowed to be stateless and answer `initialize` without handing back an id,
   * and treating that as failure would make a reachable server look absent.
   */
  async function ensureSession() {
    if (handshaken) return true
    const { reply, unreachable } = await send({
      jsonrpc: '2.0',
      id: 'dsh-siyuan-handshake',
      method: 'initialize',
      params: {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: bridgeIdentity(),
      },
    })
    if (unreachable !== undefined || reply?.error !== undefined) return false
    handshaken = true
    return true
  }

  /** Mark this bridge's own session established, after the client's initialize went upstream. */
  function adoptSession() {
    handshaken = true
  }

  /**
   * Send a request, re-handshaking once if SiYuan has forgotten the session.
   * Without this the bridge would keep a dead id after the app restarts and
   * every later call would fail with a 404 until the harness restarted.
   */
  async function request(message) {
    if (!(await ensureSession())) {
      return { unreachable: `SiYuan is not reachable at ${config.mcpUrl}. Open the SiYuan desktop app and try again.` }
    }
    let outcome = await send(message)
    if (outcome.sessionLost === true) {
      handshaken = false
      sessionId = undefined
      if (await ensureSession()) outcome = await send(message)
    }
    return outcome
  }

  return { adoptSession, ensureSession, hasSession: () => handshaken, request, send }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function doctor(config) {
  const profile = currentProfile(config)
  const report = [
    `state directory: ${stateDir()}`,
    `config file: ${config.configFile}${readJsonFile(config.configFile) === undefined ? ' (absent)' : ''}`,
    `endpoint: ${config.mcpUrl}`,
    `token: ${config.token ? `present (from ${config.tokenSource})` : 'MISSING — set it in the config file or in SiYuan itself'}`,
    `operation profile: ${profile} (${PROFILE_SUMMARY[profile]})`,
    `tool catalog: ${(() => {
      const cached = readToolsCache()
      const snapshot = readToolsSnapshot()
      const source = cached ?? snapshot
      if (source === undefined) return 'no cache and no built-in snapshot'
      return `${source.tools.length} tools — ${describeCatalog(cached, cached === undefined ? snapshot : undefined)}`
    })()}`,
    ...config.notes.map((note) => `note: ${note}`),
  ]
  for (const line of report) process.stdout.write(`${line}\n`)

  if (!config.token) return 2
  const upstream = createUpstream(config)
  const handshake = await upstream.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-siyuan-doctor', version: '1.0' } },
  })
  const initialized = handshake.reply
  if (handshake.unreachable !== undefined) {
    process.stdout.write(`initialize: FAILED — ${handshake.unreachable}\n`)
    return 3
  }
  if (initialized?.error) {
    process.stdout.write(`initialize: FAILED — ${initialized.error.message}\n`)
    return 3
  }
  const serverInfo = initialized?.result?.serverInfo
  process.stdout.write(`initialize: ok (${serverInfo?.name ?? 'unknown'} ${serverInfo?.version ?? ''})\n`)
  const listed = (await upstream.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).reply
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

  // Refresh the shipped snapshot: the live catalog plus where it came from.
  if (process.argv.includes('--dump-catalog')) {
    if (!config.token) {
      process.stderr.write('no SiYuan API token found; nothing to dump\n')
      process.exitCode = 2
      return
    }
    const upstream = createUpstream(config)
    const handshake = await upstream.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: {}, clientInfo: bridgeIdentity() },
    })
    if (handshake.unreachable !== undefined || handshake.reply?.error !== undefined) {
      process.stderr.write(`cannot dump the catalog: ${handshake.unreachable ?? handshake.reply.error.message}\n`)
      process.exitCode = 3
      return
    }
    const listed = (await upstream.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).reply
    const tools = listed?.result?.tools
    if (!Array.isArray(tools) || tools.length === 0) {
      process.stderr.write('SiYuan answered tools/list with no tools; refusing to write an empty snapshot\n')
      process.exitCode = 3
      return
    }
    process.stdout.write(`${JSON.stringify({
      note: 'Snapshot of SiYuan\'s own MCP tool catalog, used only until a live catalog is available. Refresh with: node bridge/mcp-stdio.mjs --dump-catalog > bridge/tools-snapshot.json',
      generatedAt: new Date().toISOString(),
      source: handshake.reply?.result?.serverInfo ?? { name: 'SiYuan' },
      tools,
    }, null, 1)}\n`)
    return
  }

  const upstream = createUpstream(config)

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

    // A session that exists even while SiYuan is closed. The client registers a
    // server's tools only when `initialize` succeeds, and it never retries a
    // server it failed to connect to — so answering locally is what keeps the
    // tools in the catalog across a restart with SiYuan shut, and lets them
    // start working the moment the user opens SiYuan, with no launch of the
    // app by the host and no re-registration in the client.
    if (message.method === 'initialize') {
      const { reply, unreachable } = await upstream.send(message)
      const answered = unreachable === undefined && reply?.error === undefined
      if (answered) upstream.adoptSession()
      write(answered ? reply : {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: typeof message.params?.protocolVersion === 'string'
            ? message.params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: bridgeIdentity(),
          instructions: `SiYuan is not running, so this session started without a live connection. The tool list comes from the last catalog this bridge saw; calls report the app as unreachable until it is opened.`,
        },
      })
      return
    }

    if (message.method === 'notifications/initialized') {
      // Best effort: worth forwarding only when there is a session to attach it to.
      if (upstream.hasSession()) await upstream.send(message)
      return
    }

    if (message.method === 'tools/list') {
      {
        const { reply, unreachable } = await upstream.request(message)
        if (unreachable === undefined && reply?.error === undefined) {
          writeToolsCache(reply?.result)
          write(reply)
          return
        }
      }
      const cached = readToolsCache()
      const snapshot = cached === undefined ? readToolsSnapshot() : undefined
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: (cached ?? snapshot)?.tools ?? [],
          _meta: { 'dsh-siyuan/catalog': describeCatalog(cached, snapshot) },
        },
      })
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

    // Anything else needs a live session; the handshake is lazy so a bridge
    // whose client-facing initialize was answered locally still works once
    // SiYuan appears — and it is retried if the app restarted in between.
    const { reply: answer, unreachable } = await upstream.request(message)
    if (unreachable !== undefined) {
      write(jsonRpcError(message.id, unreachable))
      return
    }
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
        // JSON-RPC notifications have no response at all, including on error.
        if (requestId !== undefined) {
          write(jsonRpcError(requestId, 'request failed: ' + safeLabel(error?.message ?? error), -32000))
        }
      })
  })

  await new Promise((resolve) => lines.on('close', resolve))
  await queue
}

main().catch((error) => {
  write(jsonRpcError(undefined, `dsh-siyuan bridge failed: ${safeLabel(error?.message ?? error)}`, -32000))
  process.exitCode = 1
})
