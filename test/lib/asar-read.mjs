/**
 * Minimal read-only ASAR reader (verification scaffolding only, not shipped).
 * Lists / extracts entries from an .asar archive without external deps.
 *
 *   node asar-read.mjs list <archive> [substring]
 *   node asar-read.mjs cat  <archive> <entry-path>
 */
import { readFile } from 'node:fs/promises'

function parseArchive(buffer) {
  const sizeBuf = buffer.subarray(0, 8)
  const headerSize = sizeBuf.readUInt32LE(4)
  const json = buffer.subarray(8, 8 + headerSize).toString('utf8')
  const header = JSON.parse(json)
  const fileStart = 8 + headerSize
  return { header, fileStart, buffer }
}

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (value.files !== undefined) walk(value, path, out)
    else out.push({ path, size: value.size ?? 0, offset: value.offset, unpacked: value.unpacked === true })
  }
}

const [, , command, archivePath, argument] = process.argv
const buffer = await readFile(archivePath)
const { header, fileStart, buffer: raw } = parseArchive(buffer)
const entries = []
walk(header, '', entries)

if (command === 'list') {
  const needle = (argument ?? '').toLowerCase()
  for (const entry of entries) {
    if (needle === '' || entry.path.toLowerCase().includes(needle)) console.log(entry.path)
  }
} else if (command === 'cat') {
  const entry = entries.find((candidate) => candidate.path === argument)
  if (entry === undefined) {
    console.error(`not found: ${argument}`)
    process.exit(2)
  }
  if (entry.unpacked) {
    console.error('entry is unpacked; read it from app.asar.unpacked')
    process.exit(3)
  }
  const start = fileStart + Number(entry.offset)
  process.stdout.write(raw.subarray(start, start + entry.size))
} else {
  console.error('usage: list|cat')
  process.exit(1)
}
