import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

const bridge = join(import.meta.dirname, '..', 'bridge', 'mcp-stdio.mjs')

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function runBridge(url, home) {
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      DSH_SIYUAN_HOME: home,
      SIYUAN_API_TOKEN: 'test-token',
      SIYUAN_MCP_URL: url,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, getOutput: () => ({ stdout, stderr }) }
}

test('preserves stdio response order when an earlier upstream call is slower', async () => {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body)
      const delay = message.id === 1 ? 60 : 0
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { id: message.id } }))
      }, delay)
    })
  })
  const port = await listen(server)
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-order-'))
  const { child, getOutput } = runBridge('http://127.0.0.1:' + port + '/mcp', home)

  try {
    child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"echo"}\n{"jsonrpc":"2.0","id":2,"method":"echo"}\n')
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
    assert.equal(exitCode, 0, getOutput().stderr)
    const responses = getOutput().stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(responses.map((item) => item.id), [1, 2])
  } finally {
    if (!child.killed) child.kill()
    await close(server)
    await rm(home, { recursive: true, force: true })
  }
})
