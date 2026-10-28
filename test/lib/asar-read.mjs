/**
 * Minimal read-only ASAR reader (verification scaffolding only, not shipped).
 * Lists / extracts entries from an .asar archive without external deps.
 *
 *   node asar-read.mjs list <archive> [substring]
 *   node asar-read.mjs cat  <archive> <entry-path>
 */
import { readFile } from 'node:fs/promises'

/**
 * Parse an Electron ASAR header.
 *
 * Two layouts are supported:
 *  - plain:  bytes 4..7 hold the header size and the header JSON starts at 8;
 *  - Pickle-wrapped (e.g. the DSH 0.2.1-rc.3 desktop `app.asar`): an extra
 *    8-byte Pickle prefix shifts the header JSON to 16, while the file data
 *    still starts at `8 + headerSize`.
 *
 * @param buffer - whole archive contents.
 */
function parseArchive(buffer) {
  const jsonStart = buffer.subarray(0, 64).indexOf('{"files"')
  if (jsonStart < 0) throw new Error('not an asar archive: header JSON not found in first 64 bytes')
  const headerSize = buffer.readUInt32LE(4)
  const fileStart = 8 + headerSize
  if (fileStart > buffer.length) throw new Error(`bad asar header size: ${headerSize}`)
  const json = buffer
    .subarray(jsonStart, fileStart)
    .toString('utf8')
    .replace(/[\u0000\s]+$/u, '')
  let header
  try {
    header = JSON.parse(json)
  } catch (error) {
    // Tolerate trailing Pickle padding: shrink to the last complete JSON object.
    let end = json.lastIndexOf('}')
    while (end > 0) {
      try {
        header = JSON.parse(json.slice(0, end + 1))
        break
      } catch {
        end = json.lastIndexOf('}', end - 1)
      }
    }
    if (header === undefined) throw error
  }
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
