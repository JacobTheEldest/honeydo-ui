import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Zero-v1 guard: the client speaks the Vikunja v2 API only. Any reference to
// the frozen v1 base path (assembled below so this file never matches itself)
// is a v1 fallback and must fail the suite with every offending file:line.
const NEEDLE = 'api/' + 'v1'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.resolve(fileURLToPath(import.meta.url))
const SCAN_DIRS = ['src', 'server', 'tests', 'scripts']
const SCAN_FILES = ['vite.config.ts', 'playwright.config.ts']
const SKIP_DIRS = new Set(['node_modules', '.git'])

function scanFile(filePath: string, matches: string[]): void {
  if (path.resolve(filePath) === SELF) return
  const lines = readFileSync(filePath, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.includes(NEEDLE)) {
      matches.push(`${path.relative(ROOT, filePath)}:${index + 1}: ${line.trim()}`)
    }
  })
}

function walkDir(dir: string, matches: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDir(full, matches)
    else if (entry.isFile()) scanFile(full, matches)
  }
}

test('no v1 API references outside this guard file', () => {
  const matches: string[] = []
  for (const dir of SCAN_DIRS) walkDir(path.join(ROOT, dir), matches)
  for (const file of SCAN_FILES) scanFile(path.join(ROOT, file), matches)
  assert.deepEqual(
    matches,
    [],
    `v1 API references found (the client is v2-only):\n${matches.join('\n')}`
  )
})
