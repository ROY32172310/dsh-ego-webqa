#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const PATCH = await readFile(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const PINNED_QA_VERSION = extractPinnedVersion(PATCH)
const TOOL_NAME = 'audit_web_page'
const DEFAULT_PROFILE = 'web'
const DEFAULT_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const WINDOWS = process.platform === 'win32'

export function extractPinnedVersion(patch) {
  const match = patch.match(/^\s*-\s*ego-webqa@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s*$/m)
  if (!match) {
    throw new Error('cordis.patch.yml must pin an exact ego-webqa version')
  }
  return match[1]
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    return { command: 'help', options: {} }
  }
  if (!['doctor', 'setup', 'verify'].includes(command)) {
    throw new Error(`unknown command: ${command}`)
  }

  const valueOptions = new Set([
    '--profile',
    '--dsh-home',
    '--dsh',
    '--pnpm',
    '--uvx',
    '--url',
  ])
  const booleanOptions = new Set([
    '--json',
    '--apply-path',
    '--skip-add',
    '--skip-browser',
    '--skip-probe',
  ])
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--help' || argument === '-h') {
      return { command: 'help', options: {} }
    }
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected argument: ${argument}`)
    }
    if (valueOptions.has(argument)) {
      const value = rest[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      options[optionKey(argument)] = value
      index += 1
      continue
    }
    if (booleanOptions.has(argument)) {
      options[optionKey(argument)] = true
      continue
    }
    throw new Error(`unknown option: ${argument}`)
  }
  return { command, options }
}

function optionKey(argument) {
  return argument
    .slice(2)
    .replace(/-([a-z])/g, (_, character) => character.toUpperCase())
}

function executableExtensions() {
  if (!WINDOWS) {
    return ['']
  }
  const raw = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM'
  return ['', ...raw.split(';').filter(Boolean).map((item) => item.toLowerCase())]
}

function pathDirectories(value = process.env.PATH || process.env.Path || '') {
  return value.split(delimiter).map((item) => item.trim()).filter(Boolean)
}

function equivalentPath(left, right) {
  const normalize = (value) => {
    const resolved = resolve(value)
    return WINDOWS ? resolved.replace(/[\\/]+$/, '').toLowerCase() : resolved.replace(/\/+$/, '')
  }
  return normalize(left) === normalize(right)
}

export function pathIncludesDirectory(value, directory) {
  return pathDirectories(value).some((entry) => equivalentPath(entry, directory))
}

function commonBinDirectories(dshHome = '') {
  const directories = [join(homedir(), '.local', 'bin')]
  if (WINDOWS) {
    if (process.env.LOCALAPPDATA) {
      directories.push(join(process.env.LOCALAPPDATA, 'Programs', 'uv'))
      directories.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'))
    }
    if (dshHome) {
      directories.push(join(dshHome, '.dsh-tools', 'bin'))
    }
  }
  return directories
}

async function isExecutable(path) {
  try {
    await access(path, WINDOWS ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findExecutable(name, explicit = '', extraDirectories = []) {
  const candidates = []
  if (explicit) {
    candidates.push(resolve(explicit))
  } else if (name.includes('/') || (WINDOWS && name.includes('\\'))) {
    candidates.push(resolve(name))
  } else {
    const directories = [
      ...pathDirectories(),
      ...extraDirectories,
      ...commonBinDirectories(),
    ]
    for (const directory of directories) {
      for (const extension of executableExtensions()) {
        candidates.push(join(directory, `${name}${extension}`))
      }
    }
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }
  return ''
}

function quoteForCmd(value) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('command arguments must not contain control characters')
  }
  return `"${value.replaceAll('"', '""')}"`
}

function spawnProcess(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdin = false,
  } = options
  if (WINDOWS && /\.(?:cmd|bat)$/i.test(command)) {
    const line = [command, ...args].map(quoteForCmd).join(' ')
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd,
      env,
      windowsHide: true,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
  }
  return spawn(command, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
}

async function runCommand(command, args, options = {}) {
  const child = spawnProcess(command, args, options)
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const maxOutput = 8 * 1024 * 1024
  child.stdout?.on('data', (chunk) => {
    if (stdout.length < maxOutput) {
      stdout += chunk.toString()
    }
  })
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < maxOutput) {
      stderr += chunk.toString()
    }
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const result = await new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolvePromise({ code, signal }))
    })
    return {
      ...result,
      timedOut,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  } finally {
    clearTimeout(timer)
  }
}

function check(id, status, message, hint = '', details = undefined) {
  const result = { id, status, message, hint }
  if (details !== undefined) {
    result.details = details
  }
  return result
}

function derivedDshHome(options, dshPath) {
  if (options.dshHome) {
    return resolve(options.dshHome)
  }
  if (process.env.DSH_HOME) {
    return resolve(process.env.DSH_HOME)
  }
  if (dshPath) {
    return dirname(dshPath)
  }
  return ''
}

async function workspaceCheck() {
  try {
    await access(process.cwd(), fsConstants.R_OK | fsConstants.W_OK)
    return check('workspace', 'ok', `Workspace is readable and writable: ${process.cwd()}`)
  } catch (error) {
    return check(
      'workspace',
      'fail',
      `Workspace is not readable and writable: ${process.cwd()}`,
      'Choose a user-owned workspace or run the DSH ACL recovery script explicitly. PATH updates do not fix ACLs.',
      String(error),
    )
  }
}

async function inspectDsh(options, dshHome) {
  const dsh = await findExecutable('dsh', options.dsh || '', [dshHome].filter(Boolean))
  if (!dsh) {
    return {
      path: '',
      check: check(
        'dsh',
        'fail',
        'DSH CLI was not found on PATH',
        'Open DSH once, locate its CLI, and rerun with --dsh <path-to-dsh>.',
      ),
    }
  }
  const version = await runCommand(dsh, ['--version'], { timeoutMs: 20_000 })
  if (version.code !== 0) {
    return {
      path: dsh,
      check: check(
        'dsh',
        'fail',
        `DSH CLI could not start: ${dsh}`,
        version.stderr || version.stdout || 'Check the DSH installation.',
      ),
    }
  }
  return {
    path: dsh,
    check: check(
      'dsh',
      'ok',
      `DSH ${version.stdout || 'version reported'}: ${dsh}`,
      '',
      { version: version.stdout, path: dsh },
    ),
  }
}

async function inspectPnpm(options, dshHome) {
  const pnpm = await findExecutable('pnpm', options.pnpm || '', [dshHome].filter(Boolean))
  if (!pnpm) {
    return {
      path: '',
      check: check(
        'pnpm',
        'warn',
        'pnpm was not found',
        'Install pnpm or pass the DSH-bundled pnpm path with --pnpm. This is only required for dsh plugin installs.',
      ),
    }
  }
  const version = await runCommand(pnpm, ['--version'], { timeoutMs: 20_000 })
  if (version.code !== 0) {
    return {
      path: pnpm,
      check: check(
        'pnpm',
        'warn',
        `pnpm could not run: ${pnpm}`,
        version.stderr || version.stdout || 'Check the pnpm shim or installation.',
      ),
    }
  }
  return {
    path: pnpm,
    check: check('pnpm', 'ok', `pnpm ${version.stdout}: ${pnpm}`),
  }
}

async function inspectUvx(options) {
  const uvx = await findExecutable('uvx', options.uvx || '')
  if (!uvx) {
    return {
      path: '',
      check: check(
        'uvx',
        'fail',
        'uvx was not found',
        'Install uv, then rerun setup --apply-path or pass --uvx <path-to-uvx>.',
      ),
    }
  }
  const version = await runCommand(uvx, ['--version'], { timeoutMs: 20_000 })
  if (version.code !== 0) {
    return {
      path: uvx,
      check: check(
        'uvx',
        'fail',
        `uvx could not run: ${uvx}`,
        version.stderr || version.stdout || 'Reinstall uv.',
      ),
    }
  }
  return {
    path: uvx,
    check: check(
      'uvx',
      'ok',
      `${version.stdout}: ${uvx}`,
      '',
      { version: version.stdout, on_path: pathIncludesDirectory(process.env.PATH, dirname(uvx)) },
    ),
  }
}

async function inspectPinnedPackage(uvx) {
  if (!uvx) {
    return check(
      'ego_webqa_package',
      'fail',
      `Cannot verify pinned ego-webqa ${PINNED_QA_VERSION} without uvx`,
    )
  }
  const result = await runCommand(
    uvx,
    ['--from', `ego-webqa==${PINNED_QA_VERSION}`, 'ego-webqa', '--version'],
    { timeoutMs: 120_000 },
  )
  if (result.code !== 0) {
    return check(
      'ego_webqa_package',
      'fail',
      `Pinned ego-webqa ${PINNED_QA_VERSION} could not start`,
      result.stderr || result.stdout || 'Check network and PyPI access.',
    )
  }
  return check(
    'ego_webqa_package',
    'ok',
    result.stdout,
    '',
    { expected: PINNED_QA_VERSION },
  )
}

async function inspectBrowser(uvx) {
  if (!uvx) {
    return check('browser', 'fail', 'Cannot verify Chromium without uvx')
  }
  const result = await runCommand(
    uvx,
    ['--from', `ego-webqa==${PINNED_QA_VERSION}`, 'ego-webqa', 'doctor', '--json'],
    { timeoutMs: 90_000 },
  )
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    return check(
      'browser',
      'fail',
      'ego-webqa doctor did not return JSON',
      result.stderr || result.stdout || 'Run the pinned doctor command directly.',
    )
  }
  if (result.code !== 0 || report.status !== 'ok') {
    const failed = (report.checks || []).filter((item) => item.status !== 'ok')
    const hint = failed.map((item) => item.hint).filter(Boolean).join(' ')
    return check(
      'browser',
      'fail',
      'Playwright Chromium is not ready',
      hint || `Run: uvx --from ego-webqa==${PINNED_QA_VERSION} playwright install chromium`,
      { doctor: report },
    )
  }
  return check('browser', 'ok', 'Playwright Chromium launched successfully', '', {
    runtime: report.runtime,
  })
}

async function inspectProfile(dsh, profile) {
  if (!dsh) {
    return check(
      'dsh_profile',
      'fail',
      `Cannot inspect DSH profile ${profile} without the DSH CLI`,
    )
  }
  const result = await runCommand(
    dsh,
    ['--profile', profile, '--dump-config'],
    { timeoutMs: 30_000 },
  )
  if (result.code !== 0) {
    return check(
      'dsh_profile',
      'fail',
      `DSH profile ${profile} did not load`,
      result.stderr || result.stdout || 'Check the profile name and DSH logs.',
    )
  }
  const configured = /id:\s*ego-webqa\b/.test(result.stdout) && /serverName:\s*ego_webqa\b/.test(result.stdout)
  if (!configured) {
    return check(
      'dsh_profile',
      'fail',
      `DSH profile ${profile} does not contain the ego-webqa MCP row`,
      `Run: npx -y dsh-ego-webqa@${PACKAGE.version} setup --profile ${profile}`,
    )
  }
  const versionMatch = result.stdout.includes(`ego-webqa@${PINNED_QA_VERSION}`)
  if (!versionMatch) {
    return check(
      'dsh_profile',
      'warn',
      `DSH profile ${profile} contains ego-webqa, but not the expected ${PINNED_QA_VERSION} pin`,
      `Reinstall with: npx -y dsh-ego-webqa@${PACKAGE.version} setup --profile ${profile}`,
    )
  }
  return check(
    'dsh_profile',
    'ok',
    `DSH profile ${profile} contains ego-webqa@${PINNED_QA_VERSION}`,
  )
}

class McpSession {
  constructor(child) {
    this.child = child
    this.buffer = ''
    this.stderr = ''
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.on('data', (chunk) => {
      if (this.stderr.length < 64 * 1024) {
        this.stderr += chunk.toString()
      }
    })
    child.once('error', (error) => this.rejectAll(error))
    child.once('exit', (code, signal) => {
      this.closed = true
      if (this.pending.size) {
        const detail = this.stderr.trim() || `MCP server exited (${code ?? signal})`
        this.rejectAll(new Error(detail))
      }
    })
  }

  static async start(uvx, options = {}) {
    const child = spawnProcess(
      uvx,
      ['--from', `ego-webqa==${PINNED_QA_VERSION}`, 'ego-webqa', 'mcp'],
      {
        cwd: options.cwd || process.cwd(),
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        stdin: true,
      },
    )
    const session = new McpSession(child)
    const initialize = await session.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-ego-webqa', version: PACKAGE.version },
    })
    session.notify('notifications/initialized', {})
    return { session, initialize }
  }

  onData(chunk) {
    this.buffer += chunk.toString()
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) {
        try {
          this.onMessage(JSON.parse(line))
        } catch {
          // MCP stdout must be JSON-RPC. Stray non-protocol output is ignored;
          // stderr remains available for actionable process diagnostics.
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  onMessage(message) {
    if (typeof message.id !== 'number') {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
    } else {
      pending.resolve(message.result)
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  send(message) {
    if (this.closed || !this.child.stdin?.writable) {
      throw new Error('MCP server is not writable')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new Error('MCP server has exited'))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async close() {
    this.closed = true
    this.rejectAll(new Error('MCP session closed'))
    this.child.stdin?.end()
    if (!this.child.killed) {
      this.child.kill()
    }
  }
}

async function inspectMcp(uvx) {
  if (!uvx) {
    return check('mcp', 'fail', 'Cannot probe MCP without uvx')
  }
  let session
  try {
    const started = await McpSession.start(uvx)
    session = started.session
    const tools = await session.request('tools/list', {}, 30_000)
    const names = (tools.tools || []).map((item) => item.name)
    if (!names.includes(TOOL_NAME)) {
      return check(
        'mcp',
        'fail',
        `MCP handshake succeeded, but ${TOOL_NAME} was not exposed`,
        `Tools returned: ${names.join(', ') || '(none)'}`,
      )
    }
    return check('mcp', 'ok', `MCP handshake exposed ${TOOL_NAME}`, '', {
      protocolVersion: started.initialize.protocolVersion,
      tools: names,
    })
  } catch (error) {
    return check(
      'mcp',
      'fail',
      `MCP startup failed: ${error.message}`,
      'Run the pinned package doctor and inspect DSH logs for startup errors.',
    )
  } finally {
    await session?.close()
  }
}

function summarize(checks) {
  if (checks.some((item) => item.status === 'fail')) {
    return 'fail'
  }
  if (checks.some((item) => item.status === 'warn')) {
    return 'warn'
  }
  return 'ok'
}

export async function doctor(options = {}) {
  const profile = options.profile || DEFAULT_PROFILE
  const checks = []
  checks.push(
    check(
      'node',
      'ok',
      `Node ${process.version} (${process.platform}/${process.arch})`,
      '',
      { executable: process.execPath },
    ),
  )
  checks.push(await workspaceCheck())

  const provisionalHome = derivedDshHome(options, '')
  const dsh = await inspectDsh(options, provisionalHome)
  checks.push(dsh.check)
  const dshHome = derivedDshHome(options, dsh.path)
  const pnpm = await inspectPnpm(options, dshHome)
  checks.push(pnpm.check)
  const uvx = await inspectUvx(options)
  checks.push(uvx.check)
  if (uvx.path) {
    checks.push(await inspectPinnedPackage(uvx.path))
    if (!options.skipBrowser) {
      checks.push(await inspectBrowser(uvx.path))
    }
  }
  if (dsh.path) {
    checks.push(await inspectProfile(dsh.path, profile))
  }
  if (!options.skipProbe && uvx.path) {
    checks.push(await inspectMcp(uvx.path))
  }

  return {
    schema_version: '1.0',
    tool: PACKAGE.name,
    version: PACKAGE.version,
    pinned_ego_webqa: PINNED_QA_VERSION,
    status: summarize(checks),
    profile,
    restart_required: false,
    checks,
  }
}

async function readWindowsUserPath(reg) {
  const result = await runCommand(reg, ['query', 'HKCU\\Environment', '/v', 'Path'], {
    timeoutMs: 20_000,
  })
  if (result.code !== 0) {
    return { value: '', type: 'REG_EXPAND_SZ' }
  }
  const match = result.stdout.match(/^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s+(.*)$/im)
  if (!match) {
    throw new Error('Could not parse the current user PATH from the Windows registry')
  }
  return { value: match[2].trim(), type: match[1] }
}

export async function addWindowsUserPath(directory) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const reg = join(systemRoot, 'System32', 'reg.exe')
  const current = await readWindowsUserPath(reg)
  if (pathIncludesDirectory(current.value, directory)) {
    if (!pathIncludesDirectory(process.env.PATH, directory)) {
      process.env.PATH = `${directory}${delimiter}${process.env.PATH || ''}`
    }
    return { changed: false, directory, backup: '' }
  }
  const backupDirectory = join(homedir(), '.dsh-ego-webqa')
  await mkdir(backupDirectory, { recursive: true })
  const backup = join(
    backupDirectory,
    `user-path-backup-${new Date().toISOString().replaceAll(':', '-')}.txt`,
  )
  await writeFile(
    backup,
    [
      `Original Windows user PATH (${current.type})`,
      current.value,
      '',
      `Appended directory: ${directory}`,
      '',
    ].join('\n'),
    'utf8',
  )
  const next = current.value ? `${current.value};${directory}` : directory
  const update = await runCommand(
    reg,
    [
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      'REG_EXPAND_SZ',
      '/d',
      next,
      '/f',
    ],
    { timeoutMs: 20_000 },
  )
  if (update.code !== 0) {
    throw new Error(update.stderr || update.stdout || 'Could not update the Windows user PATH')
  }
  process.env.PATH = `${directory}${delimiter}${process.env.PATH || ''}`
  return { changed: true, directory, backup }
}

async function ensureUvxVisible(uvxPath, options) {
  if (!uvxPath) {
    throw new Error('uvx is required; install uv before running setup')
  }
  const directory = dirname(uvxPath)
  if (pathIncludesDirectory(process.env.PATH, directory)) {
    return { changed: false, directory, backup: '' }
  }
  if (!options.applyPath) {
    throw new Error(
      `uvx exists at ${uvxPath}, but its directory is not on PATH. ` +
        'Rerun setup with --apply-path to add it safely, or add it to the DSH process PATH manually.',
    )
  }
  if (!WINDOWS) {
    throw new Error(
      `Automatic PATH changes are only supported on Windows. Add ${directory} to the DSH process PATH manually.`,
    )
  }
  return addWindowsUserPath(directory)
}

async function installBundle(dshPath, pnpmPath, profile) {
  if (!dshPath) {
    throw new Error('DSH CLI was not found; pass --dsh <path-to-dsh>')
  }
  const env = {
    ...process.env,
    PATH: pnpmPath
      ? `${dirname(pnpmPath)}${delimiter}${process.env.PATH || ''}`
      : process.env.PATH || '',
    Path: pnpmPath
      ? `${dirname(pnpmPath)}${delimiter}${process.env.Path || process.env.PATH || ''}`
      : process.env.Path || process.env.PATH || '',
  }
  const result = await runCommand(
    dshPath,
    ['plugin', '--profile', profile, 'add', `${PACKAGE.name}@${PACKAGE.version}`],
    { env, timeoutMs: INSTALL_TIMEOUT_MS },
  )
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || 'dsh plugin add failed'
    const pnpmHint = pnpmPath
      ? ''
      : ' pnpm was not found; pass --pnpm <path> or use --dsh-home so setup can locate the DSH-bundled pnpm.'
    throw new Error(`${detail}${pnpmHint}`)
  }
  return result.stdout
}

async function installChromium(uvx) {
  const result = await runCommand(
    uvx,
    ['--from', `ego-webqa==${PINNED_QA_VERSION}`, 'playwright', 'install', 'chromium'],
    { timeoutMs: INSTALL_TIMEOUT_MS },
  )
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'Chromium installation failed')
  }
  return result.stdout
}

export async function setup(options = {}) {
  const profile = options.profile || DEFAULT_PROFILE
  const before = await doctor({ ...options, skipProbe: true })
  const byId = Object.fromEntries(before.checks.map((item) => [item.id, item]))
  const initialUvx = await inspectUvx(options)
  const pathUpdate = await ensureUvxVisible(initialUvx.path, options)

  // Re-resolve after a possible PATH update.
  const uvx = await inspectUvx(options)
  if (!uvx.path) {
    throw new Error('uvx was not found after PATH setup')
  }
  const dshPath = byId.dsh?.details?.path || await findExecutable('dsh', options.dsh || '')
  const dshHome = derivedDshHome(options, dshPath)
  const pnpm = await inspectPnpm(options, dshHome)

  let pluginOutput = ''
  if (!options.skipAdd) {
    pluginOutput = await installBundle(dshPath, pnpm.path, profile)
  }
  let chromiumOutput = ''
  if (!options.skipBrowser) {
    chromiumOutput = await installChromium(uvx.path)
  }

  const finalDoctor = await doctor({ ...options, profile })
  return {
    schema_version: '1.0',
    tool: PACKAGE.name,
    version: PACKAGE.version,
    pinned_ego_webqa: PINNED_QA_VERSION,
    status: finalDoctor.status,
    profile,
    path_update: pathUpdate,
    plugin_output: pluginOutput,
    chromium_output: chromiumOutput,
    restart_required: true,
    doctor: finalDoctor,
  }
}

function resultDetails(result) {
  return (
    result?.structuredContent ||
    result?.structured_content || {
      status: result?.isError ? 'error' : 'unknown',
    }
  )
}

async function callAudit(session, argumentsValue) {
  const response = await session.request(
    'tools/call',
    { name: TOOL_NAME, arguments: argumentsValue },
    120_000,
  )
  return {
    is_error: Boolean(response.isError),
    structured: resultDetails(response),
    content: response.content || [],
  }
}

async function serveFixtures(callback) {
  const fixtureRoot = join(PACKAGE_ROOT, 'fixtures')
  const server = createServer(async (request, response) => {
    const name = request.url === '/fail.html' ? 'fail.html' : request.url === '/pass.html' ? 'pass.html' : ''
    if (!name) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    try {
      const body = await readFile(join(fixtureRoot, name))
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': body.length,
      })
      response.end(body)
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('fixture unavailable')
    }
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    return await callback(base)
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
}

function toolIssueCodes(payload) {
  return new Set((payload.issues || []).map((item) => item.code))
}

export async function verify(options = {}) {
  const checks = []
  checks.push(await workspaceCheck())
  const uvx = await inspectUvx(options)
  checks.push(uvx.check)
  if (!uvx.path) {
    return {
      schema_version: '1.0',
      tool: PACKAGE.name,
      version: PACKAGE.version,
      pinned_ego_webqa: PINNED_QA_VERSION,
      status: 'fail',
      checks,
    }
  }

  const outputRoot = await mkdtemp(join(process.env.TEMP || '/tmp', 'dsh-ego-webqa-verify-'))
  let session
  try {
    await serveFixtures(async (base) => {
      const started = await McpSession.start(uvx.path)
      session = started.session
      const tools = await session.request('tools/list', {}, 30_000)
      const names = (tools.tools || []).map((item) => item.name)
      checks.push(
        names.includes(TOOL_NAME)
          ? check('mcp', 'ok', `MCP exposed ${TOOL_NAME}`)
          : check('mcp', 'fail', `MCP did not expose ${TOOL_NAME}`),
      )

      const pass = await callAudit(session, {
        url: `${base}/pass.html`,
        out_dir: join(outputRoot, 'pass'),
        viewport_preset: 'quick',
        smoke: false,
      })
      const passStatus = pass.structured.status
      checks.push(
        passStatus === 'pass'
          ? check('pass_fixture', 'ok', 'Clean fixture returned pass')
          : check(
              'pass_fixture',
              'fail',
              `Clean fixture returned ${passStatus || 'no status'}`,
              JSON.stringify(pass.structured).slice(0, 2000),
            ),
      )

      const fail = await callAudit(session, {
        url: `${base}/fail.html`,
        out_dir: join(outputRoot, 'fail'),
        viewport_preset: 'quick',
        smoke: false,
      })
      const codes = toolIssueCodes(fail.structured)
      checks.push(
        fail.structured.status === 'fail' && codes.has('horizontal_overflow')
          ? check(
              'fail_fixture',
              'ok',
              'Known overflow fixture returned fail with horizontal_overflow',
            )
          : check(
              'fail_fixture',
              'fail',
              'Known overflow fixture did not return the expected blocking finding',
              JSON.stringify(fail.structured).slice(0, 2000),
            ),
      )

      if (options.url) {
        const external = await callAudit(session, {
          url: options.url,
          out_dir: join(outputRoot, 'external'),
          viewport_preset: 'quick',
          smoke: false,
        })
        const status = external.structured.status
        checks.push(
          ['pass', 'warn', 'fail'].includes(status)
            ? check(
                'external_url',
                status === 'fail' ? 'warn' : 'ok',
                `External URL audit completed: ${status}`,
                '',
                { status },
              )
            : check(
                'external_url',
                'fail',
                'External URL audit did not complete',
                JSON.stringify(external.structured).slice(0, 2000),
              ),
        )
      }
    })
  } catch (error) {
    checks.push(check('verify', 'fail', `Verification failed: ${error.message}`))
  } finally {
    await session?.close()
    await rm(outputRoot, { recursive: true, force: true })
  }
  return {
    schema_version: '1.0',
    tool: PACKAGE.name,
    version: PACKAGE.version,
    pinned_ego_webqa: PINNED_QA_VERSION,
    status: summarize(checks),
    checks,
  }
}

function printChecks(report) {
  console.log(`${report.tool} ${report.version}: ${report.status.toUpperCase()}`)
  for (const item of report.checks) {
    console.log(`[${item.status.toUpperCase()}] ${item.id}: ${item.message}`)
    if (item.hint) {
      console.log(`       ${item.hint}`)
    }
  }
}

function printSetup(report) {
  printChecks({ ...report, checks: report.doctor?.checks || [] })
  if (report.path_update?.changed) {
    console.log(`Updated user PATH with: ${report.path_update.directory}`)
    console.log(`Previous PATH saved at: ${report.path_update.backup}`)
  }
  console.log('Installation complete. Fully quit DSH and start it again.')
  if (report.status === 'ok') {
    console.log('After restart, run: npx -y dsh-ego-webqa verify --url <preview-url>')
  } else {
    console.log('Resolve the failed checks above, then rerun setup.')
  }
}

function usage() {
  return `dsh-ego-webqa ${PACKAGE.version}

Usage:
  dsh-ego-webqa doctor [options]
  dsh-ego-webqa setup [options]
  dsh-ego-webqa verify [--url URL] [options]

Options:
  --profile NAME       DSH profile to inspect or install (default: web)
  --dsh PATH           DSH CLI path
  --dsh-home PATH      DSH application directory
  --pnpm PATH          pnpm executable used only by dsh plugin
  --uvx PATH           uvx executable
  --apply-path         Add the uvx directory to the Windows user PATH
  --skip-add           Skip dsh plugin installation
  --skip-browser       Skip Playwright Chromium installation
  --skip-probe         Doctor: skip MCP handshake
  --json               Emit machine-readable JSON
  -h, --help           Show this help

Doctor performs read-only checks. Setup mutates only after explicit invocation,
backs up Windows PATH changes, and never changes workspace ACLs. Verify runs the
pinned MCP server against one clean page and one known overflow page.`
}

export async function main(argv = process.argv.slice(2)) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(error.message)
    console.error('')
    console.error(usage())
    return 2
  }
  if (parsed.command === 'help') {
    console.log(usage())
    return 0
  }
  const options = parsed.options
  try {
    const report =
      parsed.command === 'doctor'
        ? await doctor(options)
        : parsed.command === 'setup'
          ? await setup(options)
          : await verify(options)
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else if (parsed.command === 'setup') {
      printSetup(report)
    } else {
      printChecks(report)
    }
    return report.status === 'fail' ? 1 : 0
  } catch (error) {
    console.error(`${parsed.command}: ${error.message}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : ''
const modulePath = await realpath(fileURLToPath(import.meta.url))
if (invokedPath && invokedPath === modulePath) {
  process.exitCode = await main()
}
