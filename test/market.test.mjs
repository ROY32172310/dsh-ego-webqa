import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import test from 'node:test'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

test('market generator emits a versioned npm index and local icon', async () => {
  const previous = process.env.SOURCE_DATE_EPOCH
  const previousSource = process.env.DSH_MARKET_SOURCE
  process.env.SOURCE_DATE_EPOCH = '1790000000'
  delete process.env.DSH_MARKET_SOURCE
  try {
    await run(process.execPath, [resolve(root, 'scripts/build-market-index.mjs')], {
      cwd: root,
    })
  } finally {
    if (previous === undefined) {
      delete process.env.SOURCE_DATE_EPOCH
    } else {
      process.env.SOURCE_DATE_EPOCH = previous
    }
    if (previousSource === undefined) {
      delete process.env.DSH_MARKET_SOURCE
    } else {
      process.env.DSH_MARKET_SOURCE = previousSource
    }
  }

  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const index = JSON.parse(await readFile(resolve(root, 'site/index.json'), 'utf8'))
  const plugin = index.plugins[0]

  assert.equal(index.format, 1)
  assert.deepEqual(index.metadata.categories.browser.title, {
    en: 'Browser & Web',
    zh: '浏览器与网页',
  })
  assert.equal(plugin.name, manifest.name)
  assert.equal(plugin.icon, 'https://roy32172310.github.io/dsh-ego-webqa/icons/ego-webqa.svg')
  assert.equal(plugin.metadata.category, 'browser')
  assert.deepEqual(plugin.versions, [
    {
      version: manifest.version,
      publishTimestamp: 1790000000,
      source: {
        type: 'git',
        url: 'https://github.com/ROY32172310/dsh-ego-webqa.git',
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
      },
      engines: { dsh: manifest.engines.dsh },
    },
  ])

  const validated = parseMarketIndex(
    index,
    'https://roy32172310.github.io/dsh-ego-webqa/index.json',
  )
  assert.deepEqual(validated.plugins[0].metadata, {
    category: 'browser',
    keywords: [],
    labels: [],
    sortKeys: {},
  })
})

test('market generator can publish the plugin from npm', async () => {
  const previous = process.env.SOURCE_DATE_EPOCH
  const previousSource = process.env.DSH_MARKET_SOURCE
  process.env.SOURCE_DATE_EPOCH = '1790000000'
  process.env.DSH_MARKET_SOURCE = 'npm'
  try {
    await run(process.execPath, [resolve(root, 'scripts/build-market-index.mjs')], {
      cwd: root,
    })
  } finally {
    if (previous === undefined) {
      delete process.env.SOURCE_DATE_EPOCH
    } else {
      process.env.SOURCE_DATE_EPOCH = previous
    }
    if (previousSource === undefined) {
      delete process.env.DSH_MARKET_SOURCE
    } else {
      process.env.DSH_MARKET_SOURCE = previousSource
    }
  }

  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const index = JSON.parse(await readFile(resolve(root, 'site/index.json'), 'utf8'))
  assert.equal(index.plugins[0].versions[0].version, manifest.version)
  assert.deepEqual(index.plugins[0].versions[0].source, { type: 'npm' })
})

test('market generator advertises only the resolved public version', async () => {
  const previous = process.env.SOURCE_DATE_EPOCH
  const previousSource = process.env.DSH_MARKET_SOURCE
  const previousVersion = process.env.DSH_MARKET_VERSION
  process.env.SOURCE_DATE_EPOCH = '1790000000'
  process.env.DSH_MARKET_SOURCE = 'npm'
  process.env.DSH_MARKET_VERSION = '0.1.1'
  try {
    await run(process.execPath, [resolve(root, 'scripts/build-market-index.mjs')], {
      cwd: root,
    })
  } finally {
    if (previous === undefined) {
      delete process.env.SOURCE_DATE_EPOCH
    } else {
      process.env.SOURCE_DATE_EPOCH = previous
    }
    if (previousSource === undefined) {
      delete process.env.DSH_MARKET_SOURCE
    } else {
      process.env.DSH_MARKET_SOURCE = previousSource
    }
    if (previousVersion === undefined) {
      delete process.env.DSH_MARKET_VERSION
    } else {
      process.env.DSH_MARKET_VERSION = previousVersion
    }
  }

  const index = JSON.parse(await readFile(resolve(root, 'site/index.json'), 'utf8'))
  assert.equal(index.plugins[0].versions[0].version, '0.1.1')
  assert.deepEqual(index.plugins[0].versions[0].source, { type: 'npm' })
})
