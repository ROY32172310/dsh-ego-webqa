import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8')
}

test('declares a DSH bundle without a duplicate tool implementation', async () => {
  const manifest = JSON.parse(await read('package.json'))

  assert.equal(manifest.name, 'dsh-ego-webqa')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.bin['dsh-ego-webqa'], './bin/dsh-ego-webqa.mjs')
  assert.equal(manifest.files.includes('bin/'), true)
  assert.equal(manifest.files.includes('fixtures/'), true)
  assert.equal(manifest.scripts.check, 'node scripts/check-package.mjs')
  assert.equal('dependencies' in manifest, false)
  assert.equal('main' in manifest, false)
})

test('routes through DSH native MCP client and the stable ego-webqa entry', async () => {
  const patch = await read('cordis.patch.yml')

  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(patch, /serverName: ego_webqa/)
  assert.match(patch, /command: uvx/)
  assert.match(patch, /- ego-webqa@0\.8\.0/)
  assert.match(patch, /- mcp/)
  assert.match(patch, /cwd: !!js process\.cwd\(\)/)
})

test('fails visibly and supervises reconnects', async () => {
  const patch = await read('cordis.patch.yml')

  assert.match(patch, /toolCallTimeoutMs: 90000/)
  assert.match(patch, /failOnStartupError: true/)
  assert.match(patch, /reconnect:\n\s+enabled: true/)
  assert.match(patch, /maxAttempts: 10/)
})

test('documents prerequisites, tool name, and the one-tool boundary', async () => {
  const readme = await read('README.md')

  assert.match(readme, /mcp__ego_webqa__audit_web_page/)
  assert.match(readme, /uvx --from ego-webqa==0\.8\.0 playwright install chromium/)
  assert.match(readme, /https:\/\/roy32172310\.github\.io\/dsh-ego-webqa\/index\.json/)
  assert.match(readme, /blocking page defect is a successful tool execution with a `fail` report/)
  assert.match(readme, /MCP server exposes one tool/)
  assert.match(readme, /dsh plugin --profile web add dsh-ego-webqa/)
})

test('release workflow verifies public registry visibility', async () => {
  const workflow = await read('.github/workflows/release.yml')

  assert.match(workflow, /Verify package is publicly visible/)
  assert.match(workflow, /npm view "\$\{package\}@\$\{version\}" version/)
  assert.match(workflow, /Trusted Publisher's direct 'npm publish' permission/)
})

test('refreshes the market index after a successful release', async () => {
  const workflow = await read('.github/workflows/pages.yml')

  assert.match(workflow, /workflow_run:\n\s+workflows:\n\s+- release\n\s+types:\n\s+- completed/)
  assert.match(
    workflow,
    /github\.event\.workflow_run\.conclusion == 'success'/,
  )
})
