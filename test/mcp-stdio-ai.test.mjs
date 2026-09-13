import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

/**
 * The `ai` tool: SiYuan's own AI, driven over its HTTP API.
 *
 * Its MCP endpoint publishes note tools only, so the model configured in SiYuan
 * settings — and the agent loop built on top of it — is otherwise unreachable
 * from a client. Two properties matter and are asserted here: the tool is always
 * in the catalog, and the agent's *interactive* half works, which means the turn
 * stays open across a pause for approval instead of being cancelled when the
 * first response ends.
 */

const bridge = join(import.meta.dirname, '..', 'bridge', 'mcp-stdio.mjs')

/** A SiYuan stand-in: MCP session on /mcp, AI endpoints on /api/ai/*. */
function backend({ onConfirm } = {}) {
  const state = { confirmed: [], questions: [], permission: [] }
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const url = request.url.split('?')[0]
      const json = (payload, status = 200, headers = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers })
        response.end(JSON.stringify(payload))
      }

      if (url === '/mcp') {
        const message = JSON.parse(body)
        if (message.method === 'initialize') {
          response.setHeader('mcp-session-id', 's1')
          json({ jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'SiYuan', version: '9.9.9-test' },
          } })
          return
        }
        if (message.method === 'tools/list') {
          json({ jsonrpc: '2.0', id: message.id, result: { tools: [
            { name: 'block', description: 'Block ops.', inputSchema: { type: 'object' } },
          ] } })
          return
        }
        json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'forwarded' }] } })
        return
      }

      if (url === '/api/ai/lsCapabilities') {
        json({ code: 0, msg: '', data: [
          { id: 'native/backend/block', name: 'block', available: true, actions: [
            { name: 'get', effects: {} }, { name: 'append', effects: { localWrite: true } } ] },
          { id: 'native/backend/question', name: 'question', available: true, actions: [] },
        ] })
        return
      }

      if (url === '/api/ai/chatGPT') {
        json({ code: 0, msg: '', data: `echo:${JSON.parse(body).msg}` })
        return
      }

      if (url === '/api/ai/agent/chat') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (type, data) => response.write(`event:${type}\ndata:${JSON.stringify(data)}\n\n`)
        send('turn', { turnID: 't1' })
        send('content', { token: 'Half a ' })
        send('confirm', { name: 'block', arguments: { action: 'append' }, confirmID: 'c1', effects: { localWrite: true }, forced: false })
        // The turn stays open: approval arrives on a second connection.
        state.release = () => {
          send('tool_result', { name: 'block', callID: 'call1', roundID: 'r1', result: 'ok' })
          send('content', { token: 'sentence.' })
          send('usage', { promptTokens: 10, completionTokens: 4 })
          send('done', { turnID: 't1' })
          response.end()
        }
        return
      }

      if (url === '/api/ai/agent/confirm') {
        state.confirmed.push(JSON.parse(body))
        json({ code: 0, msg: '', data: { ok: true } })
        onConfirm?.(state.release)
        return
      }

      if (url === '/api/ai/agent/question') {
        state.questions.push(JSON.parse(body))
        json({ code: 0, msg: '', data: null })
        return
      }

      if (url === '/api/ai/agent/setPermission') {
        state.permission.push(JSON.parse(body))
        json({ code: 0, msg: '', data: null })
        return
      }

      json({ code: -1, msg: `no route ${url}` })
    })
  })
  return { server, state }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function startBridge(url, home, extraEnv = {}) {
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      DSH_SIYUAN_HOME: home,
      SIYUAN_API_TOKEN: 'test-token',
      SIYUAN_API_URL: url,
      SIYUAN_MCP_PROFILE: '',
      ...extraEnv,
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
      const settle = waiting.shift()
      if (settle) settle(JSON.parse(line))
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
const ai = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ai', arguments: args } })
const textOf = (reply) => (reply.result?.content ?? []).map((part) => part.text).join('')
/** The tool prints a hint, a blank line, then the run state as JSON. */
const stateOf = (reply) => {
  const text = textOf(reply)
  if (!text.includes('\n\n')) throw new Error(`no run state in: ${text}`)
  return JSON.parse(text.slice(text.indexOf('\n\n') + 2))
}

test('the catalog always carries the bridge tool, and the AI endpoints answer', async () => {
  const { server } = backend()
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-ai-'))
  const bridgeProcess = startBridge(`http://127.0.0.1:${port}`, home)

  try {
    await bridgeProcess.send(initialize)
    const listed = await bridgeProcess.send(listTools(2))
    assert.deepEqual(listed.result.tools.map((t) => t.name), ['block', 'ai'])

    const capabilities = await bridgeProcess.send(ai(3, { action: 'capabilities' }))
    assert.match(textOf(capabilities), /SiYuan agent capabilities \(2\)/)
    assert.match(textOf(capabilities), /block — writes: append/)

    const chat = await bridgeProcess.send(ai(4, { action: 'chat', msg: 'hi' }))
    assert.equal(textOf(chat), 'echo:hi')
  } finally {
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('an agent turn survives its approval pause and finishes on the same session', async () => {
  const { server, state } = backend({ onConfirm: (release) => setTimeout(release, 20) })
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-agent-'))
  // The agent loop can write through SiYuan's own tools, so it needs `full`.
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(home, 'config.json'), JSON.stringify({ profile: 'full' }), { mode: 0o600 }))
  const bridgeProcess = startBridge(`http://127.0.0.1:${port}`, home)

  try {
    await bridgeProcess.send(initialize)

    // 1. Start a turn: it streams some text, then asks for approval and waits.
    const started = await bridgeProcess.send(ai(2, { action: 'agent', message: 'append a line', sessionID: 'sess-1' }))
    const firstText = textOf(started)
    assert.match(firstText, /approve with action "confirm"/i, firstText)
    const awaiting = stateOf(started)
    assert.equal(awaiting.status, 'awaiting_confirm')
    assert.equal(awaiting.pending.name, 'block')
    assert.equal(awaiting.text, 'Half a ')

    // 2. Approve it — the paused turn continues on the still-open stream.
    const confirmed = await bridgeProcess.send(ai(3, { action: 'confirm', confirmID: 'c1', approved: true, always: true }))
    assert.match(textOf(confirmed), /answered the approval request/)
    assert.deepEqual(state.confirmed.map((c) => [c.confirmID, c.approved, c.always]), [['c1', true, true]])

    // 3. The same session now reports the finished turn with the full text.
    let final
    for (let attempt = 0; attempt < 20; attempt += 1) {
      final = await bridgeProcess.send(ai(4, { action: 'status', sessionID: 'sess-1' }))
      if (stateOf(final).status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const done = stateOf(final)
    assert.equal(done.status, 'done')
    assert.equal(done.text, 'Half a sentence.')
    assert.deepEqual(done.usage, { promptTokens: 10, completionTokens: 4 })
  } finally {
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('the agent actions are gated by the operation profile', async () => {
  const { server } = backend()
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-ai-policy-'))
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(home, 'config.json'), JSON.stringify({ profile: 'authoring' }), { mode: 0o600 }))
  const bridgeProcess = startBridge(`http://127.0.0.1:${port}`, home)

  try {
    await bridgeProcess.send(initialize)

    // Reading and a plain completion are fine at authoring…
    const chat = await bridgeProcess.send(ai(2, { action: 'chat', msg: 'hi' }))
    assert.equal(textOf(chat), 'echo:hi')

    // …but the agent loop, which can write through SiYuan's own tools, is not.
    const denied = await bridgeProcess.send(ai(3, { action: 'agent', message: 'do something' }))
    assert.equal(denied.error?.code, -32003, JSON.stringify(denied))
    assert.match(denied.error.message, /"authoring"/)
  } finally {
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})
