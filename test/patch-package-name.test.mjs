import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The bundle patch locates this package through the profile's node_modules, and
 * the directory it lands in is the package's own `name`. Renaming the package
 * without moving those paths (or the other way round) installs cleanly and then
 * fails at activation with a missing file, in someone else's profile — the one
 * failure a test here can catch before a release does not.
 *
 * The package name also has to stay clear of the unrelated `dsh-siyuan` package
 * on npm: this bridge resolves its own files by directory name, so a collision
 * would point the row at a stranger's code.
 */

const root = join(import.meta.dirname, '..')

test('the bundle patch paths and the bridge identity match the package name', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')

  // Only the resolved path expressions count: the surrounding prose mentions
  // `node_modules/<package name>` too, and matching that would be noise.
  const referenced = [...patch.matchAll(/new URL\('node_modules\/([^/'"]+)\//gu)]
    .map((match) => match[1])
  assert.ok(referenced.length >= 2, `expected the patch to reference the installed package, saw ${referenced.length}`)
  for (const name of referenced) {
    assert.equal(name, pkg.name, `the patch resolves node_modules/${name} but the package is named ${pkg.name}`)
  }

  const bridge = await readFile(join(root, 'bridge', 'mcp-stdio.mjs'), 'utf8')
  const fallback = /typeof pkg\?\.name === 'string' \? pkg\.name : '([^']+)'/u.exec(bridge)
  assert.equal(fallback?.[1], pkg.name, 'the identity the bridge reports without a readable package.json must be its own name')

  assert.notEqual(pkg.name, 'dsh-siyuan', 'dsh-siyuan is another author\'s package on npm; the directory name must not collide with it')
})
