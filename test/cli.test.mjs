import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  commandLineForCmd,
  executableExtensions,
  extractPinnedVersion,
  findExecutable,
  main,
  parseArgs,
  pathIncludesDirectory,
  setup,
} from '../bin/dsh-ego-webqa.mjs'

const root = resolve(import.meta.dirname, '..')
const run = promisify(execFile)

test('CLI parses the documented commands and options', () => {
  assert.deepEqual(parseArgs(['doctor', '--profile', 'web', '--json']), {
    command: 'doctor',
    options: { profile: 'web', json: true },
  })
  assert.deepEqual(parseArgs(['setup', '--apply-path', '--skip-browser']), {
    command: 'setup',
    options: { applyPath: true, skipBrowser: true },
  })
  assert.deepEqual(parseArgs(['verify', '--dsh-home', 'D:\\DSH']), {
    command: 'verify',
    options: { dshHome: 'D:\\DSH' },
  })
  assert.equal(parseArgs([]).command, 'help')
  assert.throws(() => parseArgs(['unknown']), /unknown command/)
  assert.throws(() => parseArgs(['doctor', '--profile']), /requires a value/)
})

test('CLI reads one exact QA pin and detects PATH directories', async () => {
  const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
  assert.equal(extractPinnedVersion(patch), '0.8.1')
  assert.equal(pathIncludesDirectory('/one:/two', '/two'), true)
  assert.equal(pathIncludesDirectory('/one:/two', '/three'), false)
  assert.throws(() => extractPinnedVersion('- ego-webqa mcp'), /exact ego-webqa version/)
})

test('CLI resolves explicit executables without relying on a shell', async () => {
  const executable = process.platform === 'win32' ? process.execPath : '/bin/sh'
  assert.equal(await findExecutable('unused', executable), executable)
  assert.equal(await findExecutable('definitely-not-a-real-command'), '')
})

test('Windows command execution targets PATHEXT and invokes .cmd through call', () => {
  assert.deepEqual(
    executableExtensions(true, '.EXE;.CMD;.BAT;.COM'),
    ['.exe', '.cmd', '.bat', '.com'],
  )
  assert.equal(
    commandLineForCmd('C:\\Program Files\\nodejs\\dsh.cmd', ['--version']),
    'call "C:\\Program Files\\nodejs\\dsh.cmd" "--version"',
  )
})

test('CLI help is available without touching DSH or the network', async () => {
  assert.equal(await main(['--help']), 0)
  assert.equal(await main(['bad-command']), 2)
})

test(
  'CLI executes when launched through a package-manager symlink',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dsh-ego-webqa-link-'))
    try {
      const link = resolve(directory, 'dsh-ego-webqa')
      await symlink(resolve(root, 'bin', 'dsh-ego-webqa.mjs'), link)
      const result = await run(process.execPath, [link, '--help'])
      assert.match(result.stdout, /Usage:/)
      assert.match(result.stdout, /doctor \[options\]/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test(
  'setup discovers the supplied DSH toolchain and installs the exact bundle',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dsh-ego-webqa-setup-'))
    const previousPath = process.env.PATH
    try {
      const dsh = resolve(directory, 'dsh')
      const pnpm = resolve(directory, 'pnpm')
      const uvx = resolve(directory, 'uvx')
      await writeFile(
        dsh,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "0.2.1"; exit 0; fi
if [ "$1" = "--profile" ]; then
  echo "id: ego-webqa"
  echo "serverName: ego_webqa"
  echo "command: uvx ego-webqa@0.8.1 mcp"
  exit 0
fi
if [ "$1" = "plugin" ]; then echo "installed dsh-ego-webqa@0.1.7"; exit 0; fi
exit 1
`,
        'utf8',
      )
      await writeFile(pnpm, '#!/bin/sh\necho "10.0.0"\n', 'utf8')
      await writeFile(
        uvx,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "uvx 0.12.18"; exit 0; fi
if [ "$1" = "--from" ]; then
  if [ "$4" = "setup" ]; then echo "browser setup complete"; exit 0; fi
  if [ "$4" = "doctor" ]; then echo '{"status":"ok","checks":[],"runtime":{}}'; exit 0; fi
  echo "ego-webqa 0.8.1"
  exit 0
fi
exit 1
`,
        'utf8',
      )
      await Promise.all([chmod(dsh, 0o755), chmod(pnpm, 0o755), chmod(uvx, 0o755)])
      process.env.PATH = `${directory}${delimiter}${previousPath || ''}`

      const report = await setup({
        dsh,
        pnpm,
        uvx,
        profile: 'web',
        skipProbe: true,
      })

      assert.equal(report.status, 'ok')
      assert.equal(report.restart_required, true)
      assert.match(report.plugin_output, /installed dsh-ego-webqa@0\.1\.7/)
      assert.match(report.chromium_output, /browser setup complete/)
      assert.equal(report.doctor.checks.find((item) => item.id === 'dsh_profile').status, 'ok')
    } finally {
      process.env.PATH = previousPath
      await rm(directory, { recursive: true, force: true })
    }
  },
)
