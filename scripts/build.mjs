/**
 * Build the loadable halves from `src/`.
 *
 * The browser half ships as a plain browser script and the host half as ESM, so
 * the build is a straight copy — no bundler, no network, no code generation.
 *
 *   node scripts/build.mjs
 */
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url))
const outputDirectory = fileURLToPath(new URL('../lib/', import.meta.url))

await mkdir(outputDirectory, { recursive: true })
const entries = await readdir(sourceDirectory)
const copied = []
for (const entry of entries) {
  if (!entry.endsWith('.js')) continue
  await copyFile(`${sourceDirectory}${entry}`, `${outputDirectory}${entry}`)
  copied.push(entry)
}
const sizes = await Promise.all(copied.map(async (entry) => {
  const info = await stat(`${outputDirectory}${entry}`)
  return `${entry} ${(info.size / 1024).toFixed(1)} KiB`
}))
console.log(`dsh-thinking-zh: built ${copied.length} file(s) — ${sizes.join(', ')}`)
