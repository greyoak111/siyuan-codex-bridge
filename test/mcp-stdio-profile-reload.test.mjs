import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

/**
 * The operation profile is a knob users turn while the bridge is running:
 * `siyuan-scope` rewrites one key of config.json and expects the next call to be
 * decided by the new value. Freezing it at startup makes that silent — the
 * process keeps answering with the level it booted on, and only a restart
 * changes it. Both directions are asserted, because a level that cannot be
 * lowered immediately is the more dangerous half of the same bug.
 */

const bridge = join(import.meta.dirname, '..', 'bridge', 'mcp-stdio.mjs')

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

/** A backend that accepts anything, so only the bridge's own policy decides. */
function backend() {
  return createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }))
    })
  })
}

function startBridge(url, home, extraEnv = {}) {
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      DSH_SIYUAN_HOME: home,
      SIYUAN_API_TOKEN: 'test-token',
      SIYUAN_MCP_URL: url,
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

async function writeProfile(home, profile) {
  await writeFile(join(home, 'config.json'), JSON.stringify({ profile }), { mode: 0o600 })
}

/** `sql` is a full-only tool, so one action is enough to read the effective level. */
function sqlCall(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'sql', arguments: { action: 'query', stmt: 'SELECT 1' } },
  }
}

test('a profile change applies to the next call without restarting the bridge', async () => {
  const server = backend()
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-profile-'))
  await writeProfile(home, 'readonly')
  const { child, send } = startBridge(`http://127.0.0.1:${port}/mcp`, home)

  try {
    const denied = await send(sqlCall(1))
    assert.equal(denied.error?.code, -32003, `expected readonly to deny sql, got ${JSON.stringify(denied)}`)
    assert.match(denied.error.message, /"readonly"/)

    // Raised while the process is running: the very next call must be allowed.
    await writeProfile(home, 'full')
    const allowed = await send(sqlCall(2))
    assert.equal(allowed.error, undefined, `raise did not apply: ${JSON.stringify(allowed)}`)
    assert.deepEqual(allowed.result, { content: [] })

    // And lowered again: the next call must be denied immediately, without a restart.
    await writeProfile(home, 'readonly')
    const deniedAgain = await send(sqlCall(3))
    assert.equal(deniedAgain.error?.code, -32003, `lower did not apply: ${JSON.stringify(deniedAgain)}`)
  } finally {
    child.stdin.end()
    child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})

test('SIYUAN_MCP_PROFILE outranks the config file', async () => {
  const server = backend()
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-profile-env-'))
  // The file says `full`; an explicit environment statement must win over a key
  // in a user config file, and must keep winning after the file is rewritten.
  await writeProfile(home, 'full')
  const { child, send } = startBridge(`http://127.0.0.1:${port}/mcp`, home, { SIYUAN_MCP_PROFILE: 'readonly' })

  try {
    const denied = await send(sqlCall(1))
    assert.equal(denied.error?.code, -32003, `env did not win: ${JSON.stringify(denied)}`)
    assert.match(denied.error.message, /"readonly"/)

    await writeProfile(home, 'full')
    const stillDenied = await send(sqlCall(2))
    assert.equal(stillDenied.error?.code, -32003, `file overruled the environment: ${JSON.stringify(stillDenied)}`)
  } finally {
    child.stdin.end()
    child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})
