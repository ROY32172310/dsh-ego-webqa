import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const root = resolve(import.meta.dirname, '..')
const site = resolve(root, 'site')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const now = Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000))
const indexUrl = 'https://roy32172310.github.io/dsh-ego-webqa/index.json'

if (!Number.isSafeInteger(now) || now < 0) {
  throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer')
}

await mkdir(resolve(site, 'icons'), { recursive: true })
await copyFile(resolve(root, 'icon.svg'), resolve(site, 'icons', 'ego-webqa.svg'))

const index = {
  format: 1,
  title: {
    en: 'ego-webqa',
    zh: 'ego-webqa',
  },
  description: {
    en: 'Deterministic web-delivery checks for AI-generated pages.',
    zh: '面向 AI 生成页面的确定性交付粗检。',
  },
  metadata: {
    categories: {
      browser: {
        title: {
          en: 'Browser & Web',
          zh: '浏览器与网页',
        },
      },
    },
  },
  plugins: [
    {
      name: manifest.name,
      title: 'ego-webqa',
      description: {
        en: 'Audit a deployed page in real Chromium across the mobile matrix and return repair-ready evidence to DSH.',
        zh: '在真实 Chromium 中按移动端矩阵检查已部署页面，并向 DSH 返回可直接修复的证据。',
      },
      icon: 'icons/ego-webqa.svg',
      author: manifest.author,
      homepage: manifest.homepage,
      repository: {
        url: 'https://github.com/ROY32172310/dsh-ego-webqa',
      },
      metadata: {
        category: 'browser',
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp: now,
          source: { type: 'npm' },
          engines: { dsh: manifest.engines.dsh },
        },
      ],
    },
  ],
}

const validated = parseMarketIndex(index, indexUrl)

await writeFile(resolve(site, 'index.json'), `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
console.log(`Built ${resolve(site, 'index.json')}`)
