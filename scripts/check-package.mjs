import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
const readme = await readFile(resolve(root, 'README.md'), 'utf8')

assert.equal(manifest.name, 'dsh-ego-webqa')
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
assert.equal(manifest.bin['dsh-ego-webqa'], './bin/dsh-ego-webqa.mjs')
assert.equal(manifest.files.includes('cordis.patch.yml'), true)
assert.equal(manifest.files.includes('bin/'), true)
assert.equal(manifest.files.includes('fixtures/'), true)
assert.match(manifest.engines.dsh, />=0\.1\.5-rc\.1/)

assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/)
assert.match(patch, /serverName: ego_webqa/)
assert.match(patch, /command: uvx/)
assert.match(patch, /- ego-webqa@\d+\.\d+\.\d+/)
assert.match(patch, /- mcp/)
assert.match(patch, /failOnStartupError: true/)
assert.match(readme, /mcp__ego_webqa__audit_web_page/)
assert.match(readme, /uvx --from ego-webqa==\d+\.\d+\.\d+ ego-webqa setup/)

console.log('DSH bundle manifest and contract check passed.')
