import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

/**
 * `launchOnCall`: a call brings SiYuan up when it is closed, nothing else does.
 *
 * The distinction is the whole point. Registering tools, answering the
 * handshake, listing the catalog — none of that may start a desktop
 * application, because those happen when the harness opens, and an editor
 * starting someone's notes app is exactly the surprise this feature has to
 * avoid. Only a real `tools/call` reaches for it.
 *
 * The launch command here is a `/bin/sh` script that records that it ran and
 * the environment it was given; the endpoint it is supposed to bring up is
 * served by this test, and only once that marker appears. Nothing about the
 * fake needs a node interpreter on the other side of the launch, which is what
 * lets the environment assertions below stay honest.
 */

const bridge = join(import.meta.dirname, '..', 'bridge', 'mcp-stdio.mjs')

const LAUNCHER = `#!/bin/sh
marker="$1"
{
  echo launched
  env
} > "$marker"
`

/** A port nothing listens on: bind, read it, release it. */
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** The SiYuan side of the conversation: just enough MCP to answer one call. */
function fakeSiyuan() {
  return createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (request.url.startsWith('/api/system/version')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"code":0,"data":"9.9.9-test"}')
        return
      }
      const message = body.trim() === '' ? {} : JSON.parse(body)
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'SiYuan', version: '9.9.9-test' },
        } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'started and answered' }] },
      }))
    })
  })
}

function startBridge(config) {
  const child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      DSH_SIYUAN_HOME: config.home,
      SIYUAN_API_TOKEN: 'test-token',
      SIYUAN_API_URL: `http://127.0.0.1:${config.port}`,
      SIYUAN_LAUNCH_ON_CALL: config.launchOnCall === true ? '1' : '',
      SIYUAN_LAUNCH_COMMAND: config.launchCommand,
      SIYUAN_LAUNCH_TIMEOUT_MS: '15000',
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

/** The marker's first line says it ran; the rest is the environment it inherited. */
async function launchRecord(path) {
  const [first, ...rest] = (await readFile(path, 'utf8')).split('\n')
  const environment = {}
  for (const line of rest) {
    if (line.trim() === '') continue
    const equals = line.indexOf('=')
    environment[line.slice(0, equals)] = line.slice(equals + 1)
  }
  return { state: first.trim(), environment }
}

/** Wait for a file to appear, so the test can serve the app only after it starts. */
async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }
const listTools = (id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })
const callTool = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'system', arguments: { action: 'version' } } })
const textOf = (reply) => (reply.result?.content ?? []).map((part) => part.text).join('')

/** One throwaway home plus a launch command whose only job is to prove it ran. */
async function fixture(launchOnCall) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-siyuan-launch-'))
  const marker = join(home, 'launched.marker')
  const launcher = join(home, 'launcher.sh')
  await writeFile(launcher, LAUNCHER, 'utf8')
  return {
    home,
    marker,
    port: await freePort(),
    launchCommand: `/bin/sh ${JSON.stringify(launcher)} ${JSON.stringify(marker)}`,
    launchOnCall,
  }
}

test('a session that never reaches SiYuan does not start it', async () => {
  const f = await fixture(false)
  const bridgeProcess = startBridge(f)
  try {
    await bridgeProcess.send(initialize)
    const listed = await bridgeProcess.send(listTools(2))
    assert.ok(listed.result.tools.length > 0, 'the shipped snapshot still lists tools')

    const refused = await bridgeProcess.send(callTool(3))
    assert.match(refused.error?.message ?? '', /not reachable/)
    assert.equal(existsSync(f.marker), false, 'the launcher must not run when launchOnCall is off')
  } finally {
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('the handshake and the catalog never start SiYuan, even with launchOnCall on', async () => {
  const f = await fixture(true)
  const bridgeProcess = startBridge(f)
  try {
    const started = await bridgeProcess.send(initialize)
    assert.equal(started.error, undefined, JSON.stringify(started))
    const listed = await bridgeProcess.send(listTools(2))
    assert.ok(listed.result.tools.length > 0)

    // This is the behaviour the feature has to keep: opening the harness, or a
    // client asking what tools exist, starts nothing.
    assert.equal(existsSync(f.marker), false, 'merely connecting must not launch the app')
  } finally {
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('the switch is read per call, so turning it on needs no restart', async () => {
  const f = await fixture(false)
  const bridgeProcess = startBridge(f)
  const siyuan = fakeSiyuan()
  let serving
  try {
    await bridgeProcess.send(initialize)
    const before = await bridgeProcess.send(callTool(2))
    assert.match(before.error?.message ?? '', /not reachable/)
    assert.equal(existsSync(f.marker), false)

    // The user edits the config while the bridge is running — the same trap the
    // operation profile had, and the same answer: read it again on the next call.
    await writeFile(join(f.home, 'config.json'), JSON.stringify({ launchOnCall: true }))
    const answered = bridgeProcess.send(callTool(3))
    assert.equal(await waitForFile(f.marker, 5000), true, 'the next call picks the switch up')
    serving = new Promise((resolve) => siyuan.listen(f.port, '127.0.0.1', resolve))

    const reply = await answered
    assert.equal(reply.error, undefined, `call after the switch: ${JSON.stringify(reply)}`)
    assert.equal(textOf(reply), 'started and answered')
  } finally {
    await serving
    await new Promise((resolve) => siyuan.close(resolve))
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await rm(f.home, { recursive: true, force: true })
  }
})

test('a tool call brings SiYuan up and then goes through', async () => {
  const f = await fixture(true)
  const bridgeProcess = startBridge(f)
  // Nothing is listening yet. The endpoint appears only after the launch
  // command has run, so the bridge cannot pass its own reachability check by
  // accident — it has to wait for the app it started.
  const siyuan = fakeSiyuan()
  let serving
  try {
    await bridgeProcess.send(initialize)
    const answered = bridgeProcess.send(callTool(2))

    assert.equal(await waitForFile(f.marker, 5000), true, 'the call is what reaches for the app')
    serving = new Promise((resolve) => siyuan.listen(f.port, '127.0.0.1', resolve))

    const reply = await answered
    assert.equal(reply.error, undefined, `call after launch: ${JSON.stringify(reply)}`)
    assert.equal(textOf(reply), 'started and answered')

    const record = await launchRecord(f.marker)
    assert.equal(record.state, 'launched')
    // The app inherits the user's environment minus what would break it: an
    // Electron app that inherits __CFBundleIdentifier from an agent shell exits
    // silently, and ELECTRON_RUN_AS_NODE would run it as a node process.
    assert.ok(record.environment.HOME, 'HOME survives, so the app finds its data')
    assert.ok(record.environment.PATH, 'PATH survives, so a configured launcher still works')
    for (const key of ['__CFBundleIdentifier', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
      assert.equal(key in record.environment, false, `${key} must not reach the app`)
    }
    assert.equal(Object.keys(record.environment).some((key) => key.startsWith('DSH_')), false)
  } finally {
    await serving
    await new Promise((resolve) => siyuan.close(resolve))
    bridgeProcess.child.stdin.end()
    bridgeProcess.child.kill()
    await rm(f.home, { recursive: true, force: true })
  }
})
