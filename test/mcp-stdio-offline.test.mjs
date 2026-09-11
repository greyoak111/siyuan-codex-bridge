import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

/**
 * A session must survive SiYuan being closed.
 *
 * The MCP client registers a server's tools only when `initialize` succeeds,
 * and it never retries a server it could not reach — so a bridge that depends
 * on SiYuan at handshake time loses its tools for the whole session when the
 * app happens to be shut. The bridge therefore answers the handshake itself and
 * serves the last catalog it saw, while every call still reports the truth.
 *
 * The other half is recovery: the app is opened later, and the very next call
 * has to work without restarting anything.
 */

const bridge = join(import.meta.dirname, '..', 'bridge', 'mcp-stdio.mjs')

const TOOLS = [
  {
    name: 'system',
    description: 'System info.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['version'] } } },
  },
]

/** A stand-in for SiYuan's own MCP endpoint: one session, one tool. */
function backend() {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body)
      const send = (payload) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 'test-session')
        send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'SiYuan', version: '9.9.9-test' },
        } })
        return
      }
      if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
        return
      }
      if (message.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'answered' }] } })
        return
      }
      send({ jsonrpc: '2.0', id: message.id, result: {} })
    })
  })
  return server
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function startBridge(url, home) {
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      DSH_SIYUAN_HOME: home,
      SIYUAN_API_TOKEN: 'test-token',
      SIYUAN_MCP_URL: url,
      SIYUAN_MCP_PROFILE: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = []
  const waiting = []
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop()
    for (const line of lines) {
      if (line.trim() === '') continue
      const wait = waiting.shift()
      if (wait) wait(JSON.parse(line))
      else pending.push(JSON.parse(line))
    }
  })
  return {
    child,
    send(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`)
      if (pending.length > 0) return Promise.resolve(pending.shift())
      return new Promise((resolve) => waiting.push(resolve))
    },
  }
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }
const listTools = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })
const callTool = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'system', arguments: { action: 'version' } } })

test('the handshake survives SiYuan being absent, and calls recover when it appears', async () => {
  const server = backend()
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}/mcp`
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-offline-'))

  // First session, with the backend up: this is what fills the catalog cache.
  const first = startBridge(url, home)
  try {
    const started = await first.send(initialize)
    assert.equal(started.result?.serverInfo?.name, 'SiYuan', JSON.stringify(started))
    const listed = await first.send(listTools(2))
    assert.equal(listed.result.tools.length, 1)
  } finally {
    first.child.stdin.end()
    first.child.kill()
  }
  await close(server)

  // Second session, SiYuan closed: the client must still get a session and a
  // tool list — from the cache — while calls report the app as away.
  const offline = startBridge(url, home)
  try {
    const started = await offline.send(initialize)
    assert.equal(started.error, undefined, `initialize must not fail while SiYuan is closed: ${JSON.stringify(started)}`)
    assert.equal(started.result?.serverInfo?.name, 'dsh-siyuan')

    const listed = await offline.send(listTools(2))
    assert.deepEqual(listed.result.tools, TOOLS, 'the cached catalog is what keeps the tools registered')
    assert.match(listed.result._meta['dsh-siyuan/catalog'], /cached/)

    const refused = await offline.send(callTool(3))
    assert.match(refused.error?.message ?? '', /not reachable/)
    assert.equal(refused.result, undefined)

    // The user opens SiYuan: the next call must work, with no restart.
    const revived = backend()
    const revivedPort = await listen(revived, port)
    assert.equal(revivedPort, port)
    try {
      const live = await offline.send(callTool(4))
      assert.equal(live.error, undefined, `call after SiYuan came back: ${JSON.stringify(live)}`)
      assert.equal(live.result.content[0].text, 'answered')

      const refreshed = await offline.send(listTools(5))
      assert.deepEqual(refreshed.result.tools, TOOLS)
      assert.equal(refreshed.result._meta, undefined, 'a live catalog is not annotated as cached')
    } finally {
      await close(revived)
    }
  } finally {
    offline.child.stdin.end()
    offline.child.kill()
  }
  await rm(home, { recursive: true, force: true })
})

test('a cold start with no cache is filled by the shipped snapshot', async () => {
  // A fresh install where SiYuan has never been opened has no cache. Listing
  // nothing would read as "this plugin does nothing", so the package carries a
  // snapshot of SiYuan's own catalog for exactly this case.
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-coldstart-'))
  // Port 9 is the discard port: reliably nothing listens there.
  const cold = startBridge('http://127.0.0.1:9/mcp', home)
  try {
    const started = await cold.send(initialize)
    assert.equal(started.error, undefined, JSON.stringify(started))
    assert.equal(started.result.capabilities.tools.listChanged, true)

    const listed = await cold.send(listTools(2))
    assert.ok(listed.result.tools.length > 0, 'the shipped snapshot must fill a cold start')
    for (const tool of listed.result.tools) {
      assert.equal(typeof tool.name, 'string')
      assert.equal(typeof tool.inputSchema, 'object')
    }
    assert.match(listed.result._meta['dsh-siyuan/catalog'], /built-in snapshot/)

    const refused = await cold.send(callTool(3))
    assert.match(refused.error?.message ?? '', /not reachable/)
  } finally {
    cold.child.stdin.end()
    cold.child.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('a restarted SiYuan invalidates the session and the next call recovers by itself', async () => {
  // SiYuan answers 404 for a session it no longer knows, which is exactly what
  // happens when the user quits and reopens the app. Without a re-handshake the
  // bridge would keep sending the dead id and every later call would fail.
  let current = 'session-1'
  let initializes = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body)
      const offered = request.headers['mcp-session-id']
      if (message.method === 'initialize') {
        initializes += 1
        current = `session-${initializes}`
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': current })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'SiYuan', version: '9.9.9-test' },
        } }))
        return
      }
      if (offered !== current) {
        response.writeHead(404)
        response.end('')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'answered' }] } }))
    })
  })
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-session-'))
  const bridgeProcess = startBridge(`http://127.0.0.1:${port}/mcp`, home)

  try {
    await bridgeProcess.send(initialize)
    const first = await bridgeProcess.send(callTool(2))
    assert.equal(first.result.content[0].text, 'answered')
    assert.equal(initializes, 1)

    // The app restarts: its sessions are gone.
    current = 'session-after-restart'

    const afterRestart = await bridgeProcess.send(callTool(3))
    assert.equal(afterRestart.error, undefined, `call after restart: ${JSON.stringify(afterRestart)}`)
    assert.equal(afterRestart.result.content[0].text, 'answered')
    assert.equal(initializes, 2, 'the bridge must handshake again after the 404')
  } finally {
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})
