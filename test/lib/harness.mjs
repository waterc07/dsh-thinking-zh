/**
 * Verification harness for `dsh-thinking-zh` host half.
 *
 * Read-only against `src/`: imports the module with a cache-busting query so each
 * case starts from pristine module state, and mounts its routes on a real
 * `node:http` server that mirrors `@deepseek-ai/dsh-host-webserver`'s listener
 * semantics (pathname matching, handler-error containment).
 */
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Everything derives from this file's location, so the suite runs from any
// checkout and from any working directory. Paths are normalized to forward
// slashes to match the `/`-joined literals used below.
export const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/u, '').replace(/\\/gu, '/')
export const INDEX_PATH = `${PLUGIN_DIR}/src/index.js`
export const EVIDENCE_DIR = `${PLUGIN_DIR}/test/evidence`
// `$DSH_HOME` sandbox for every case. Overridable so a run can keep its
// scratch state inside the checkout (and thus out of the user's temp profile):
//   DSH_THINKING_ZH_TEST_HOME=test/.tmp-home node test/host-security.test.mjs
export const HOME_ROOT = process.env.DSH_THINKING_ZH_TEST_HOME ?? join(tmpdir(), 'zh-verify-home')

let importSequence = 0

export function makeHome(tag) {
  const path = join(HOME_ROOT, `${tag}-${String(Date.now())}-${String(importSequence + 1)}`)
  return mkdir(path, { recursive: true }).then(() => path)
}

/** Import a pristine module instance bound to `home` via `$DSH_HOME`. */
export async function loadPlugin(home) {
  process.env.DSH_HOME = home
  importSequence += 1
  const url = `${pathToFileURL(INDEX_PATH).href}?case=${String(importSequence)}&t=${String(Date.now())}`
  return import(url)
}

/**
 * Mount the plugin routes on a real HTTP server. Mirrors the host webserver:
 * handler rejections are contained (400 before headers, destroy after).
 */
export async function startServer(plugin, options = {}) {
  const routes = plugin.makeRoutes()
  const server = http.createServer((req, res) => {
    const handle = async () => {
      let pathname
      try {
        pathname = new URL(req.url ?? '/', 'http://x').pathname
      } catch {
        pathname = '/'
      }
      const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname)
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      await route.handler(req, res)
    }
    handle().catch((error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end(String(error))
    })
  })
  const host = options.host ?? '127.0.0.1'
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const { port } = server.address()
  return {
    server,
    port,
    routes,
    base: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => { resolve() })
    }),
  }
}

/** Send one JSON request; never throws on connection reset (returns `reset:true`). */
export function request(base, path, options = {}) {
  const url = new URL(path, base)
  const body = options.body === undefined
    ? undefined
    : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
  const headers = { ...(options.headers ?? {}) }
  if (body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(body.byteLength)
  }
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode, headers: res.headers, text, json, reset: false })
      })
    })
    req.on('error', (error) => resolve({ status: 0, headers: {}, text: '', json: undefined, reset: true, error: error.message }))
    req.setTimeout(options.timeout ?? 30_000, () => {
      req.destroy(new Error('client timeout'))
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Send a raw request with explicit control over Host / Origin and body framing.
 * `omitHost: true` sends no Host header (HTTP/1.0 style).
 */
export function rawRequest(port, options = {}) {
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  const headers = { ...(options.headers ?? {}) }
  if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(body.byteLength)
  return new Promise((resolve) => {
    const req = http.request({
      host: options.connectHost ?? '127.0.0.1',
      port,
      path: options.path ?? '/',
      method: options.method ?? 'GET',
      headers,
      setHost: options.omitHost === true ? false : true,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode, headers: res.headers, text, json, reset: false })
      })
    })
    req.on('error', (error) => resolve({ status: 0, headers: {}, text: '', json: undefined, reset: true, error: error.message }))
    req.setTimeout(options.timeout ?? 30_000, () => { req.destroy(new Error('client timeout')) })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Send a hand-written HTTP/1.1 request over a raw TCP socket. Needed where
 * `node:http` refuses to send a forged Host header (Node >= 24 validates that
 * Host matches the request authority) and where a peer address other than
 * loopback must be exercised.
 */
export function rawSocketRequest(options = {}) {
  const connectHost = options.connectHost ?? '127.0.0.1'
  const port = options.port
  const lines = [`${options.method ?? 'GET'} ${options.path ?? '/'} HTTP/${options.httpVersion ?? '1.1'}`]
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) continue
    lines.push(`${name}: ${value}`)
  }
  lines.push('Connection: close')
  const head = `${lines.join('\r\n')}\r\n\r\n`
  const body = options.body === undefined ? '' : options.body
  return new Promise((resolve) => {
    const socket = net.connect({ host: connectHost, port })
    const chunks = []
    let settled = false
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already gone */ }
      const raw = Buffer.concat(chunks).toString('utf8')
      const splitAt = raw.indexOf('\r\n\r\n')
      const headerText = splitAt === -1 ? raw : raw.slice(0, splitAt)
      const bodyText = splitAt === -1 ? '' : raw.slice(splitAt + 4)
      const statusLine = headerText.split('\r\n')[0] ?? ''
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)
      const headers = {}
      for (const line of headerText.split('\r\n').slice(1)) {
        const at = line.indexOf(':')
        if (at === -1) continue
        headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
      }
      let json
      try { json = JSON.parse(bodyText) } catch { json = undefined }
      resolve({ status: match === null ? 0 : Number(match[1]), headers, text: bodyText, json, raw, ...extra })
    }
    socket.setTimeout(options.timeout ?? 8_000, () => finish({ reset: true, error: 'timeout' }))
    socket.on('connect', () => { socket.write(head + body) })
    socket.on('data', (chunk) => { chunks.push(chunk) })
    socket.on('end', () => finish({ reset: false }))
    socket.on('close', () => finish({ reset: false }))
    socket.on('error', (error) => finish({ reset: true, error: error.message }))
  })
}

/**
 * Replace `globalThis.fetch`. `handler(url, options, callIndex)` may return a
 * fake Response. The returned object records every call and restores the real
 * fetch on `restore()`.
 */
export function stubFetch(handler) {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const record = { url: String(url), options, at: Date.now() }
    calls.push(record)
    const result = await handler(url, options, calls.length - 1)
    return result
  }
  return {
    calls,
    restore: () => { globalThis.fetch = real },
  }
}

/** Wrap the real fetch to count calls while keeping real network behavior. */
export function countingFetch() {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return real(url, options)
  }
  return {
    calls,
    restore: () => { globalThis.fetch = real },
  }
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

export function bingHappy(translate = (text) => `译:${text}`) {
  return (url, options) => {
    const texts = JSON.parse(options.body)
    return jsonResponse(texts.map((text) => ({ translations: [{ text: translate(text), to: 'zh-Hans' }] })))
  }
}

/** Read one directory's file names, or `[]` when absent. */
export async function listDirectory(path) {
  try { return await readdir(path) } catch { return [] }
}

/** Read a JSON file, or `undefined` when absent/unparseable. */
export async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}

export async function statOrUndefined(path) {
  try { return await stat(path) } catch { return undefined }
}

export async function fileText(path) {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}

export async function ensureEvidenceDir() {
  await mkdir(EVIDENCE_DIR, { recursive: true })
  return EVIDENCE_DIR
}

/** Minimal test registry with PASS/FAIL collection and JSON output. */
export function createSuite(name) {
  const cases = []
  return {
    name,
    cases,
    async test(title, fn) {
      const started = Date.now()
      try {
        const detail = await fn()
        const record = { title, status: 'PASS', detail: normalize(detail), ms: Date.now() - started }
        cases.push(record)
        console.log(`[PASS] ${title}${record.detail === undefined ? '' : ` — ${record.detail}`}`)
      } catch (error) {
        const record = { title, status: 'FAIL', detail: portablePath(error instanceof Error ? error.message : String(error)), ms: Date.now() - started }
        cases.push(record)
        console.log(`[FAIL] ${title} — ${record.detail}`)
      }
    },
    async note(title, fn) {
      const started = Date.now()
      try {
        const detail = await fn()
        const record = { title, status: 'NOTE', detail: normalize(detail), ms: Date.now() - started }
        cases.push(record)
        console.log(`[NOTE] ${title}${record.detail === undefined ? '' : ` — ${record.detail}`}`)
      } catch (error) {
        const record = { title, status: 'ERROR', detail: portablePath(error instanceof Error ? error.message : String(error)), ms: Date.now() - started }
        cases.push(record)
        console.log(`[ERROR] ${title} — ${record.detail}`)
      }
    },
    summary() {
      const counts = { PASS: 0, FAIL: 0, NOTE: 0, ERROR: 0 }
      for (const item of cases) counts[item.status] += 1
      return { suite: name, counts, cases }
    },
  }
}

/** Every spelling a machine-specific root takes inside a JS/JSON string. */
function rootVariants(root) {
  if (typeof root !== 'string' || root === '') return []
  const forward = root.replace(/\\/gu, '/')
  const backward = root.replace(/\//gu, '\\')
  return [root, forward, backward, backward.replace(/\\/gu, '\\\\')]
}

/**
 * Replace absolute checkout/scratch paths so the committed evidence JSON does
 * not leak a user name or install location. `JSON.stringify` doubles backslashes
 * when a path is nested inside another string, hence the doubled variant.
 */
export function portablePath(text) {
  let out = String(text)
  for (const root of rootVariants(PLUGIN_DIR)) out = out.split(root).join('$PLUGIN_DIR')
  if (isAbsolute(HOME_ROOT)) {
    for (const root of rootVariants(HOME_ROOT)) out = out.split(root).join('$DSH_HOME')
  }
  return out
}

function normalize(value) {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const text = portablePath(value)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }
  try { return portablePath(JSON.stringify(value)).slice(0, 400) } catch { return portablePath(String(value)) }
}

/** Assertion helpers. */
export function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

export function assertIncludes(haystack, needle, label) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(`${label}: expected to include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)?.slice(0, 200)}`)
  }
}

export function assertCjk(text, label) {
  if (typeof text !== 'string' || !/[\u3400-\u9fff]/.test(text)) {
    throw new Error(`${label}: expected CJK text, got ${JSON.stringify(text)}`)
  }
}

export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
