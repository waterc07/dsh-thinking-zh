/**
 * Host half of `dsh-thinking-zh`.
 *
 * The desktop shell is served from a random loopback port on every launch, so the
 * browser half cannot call a third-party translation API directly (CORS + opaque
 * origin). This plugin owns that hop on the Web UI origin instead:
 *
 *   GET  /api/dsh-thinking-zh/state      -> { enabled, targetLanguage, provider, rev }
 *   POST /api/dsh-thinking-zh/translate  -> { results: [{ id, text, cached }] }
 *   POST /api/dsh-thinking-zh/set        -> { enabled?, targetLanguage? } -> state
 *   POST /api/dsh-thinking-zh/diag       -> dump client-reported JSON under $DSH_HOME
 *
 * Translation is free: the Microsoft Edge anonymous endpoint that upstream DSH
 * already uses for its own reasoning translation. Results are cached in memory
 * and on disk, because the browser half re-runs its pass after every transcript
 * mutation and must never pay twice for the same sentence.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-thinking-zh'

/** Required services: the Web route registry. */
export const inject = ['webServer']

/** Route paths (the browser half mirrors these literals). */
export const ROUTES = {
  state: '/api/dsh-thinking-zh/state',
  translate: '/api/dsh-thinking-zh/translate',
  set: '/api/dsh-thinking-zh/set',
  diag: '/api/dsh-thinking-zh/diag',
}

/** Anonymous providers and their endpoints. */
export const PROVIDERS = {
  bing: 'https://edge.microsoft.com/translate/translatetext',
  google: 'https://translate.googleapis.com/translate_a/single',
}

/** Accepted target languages -> provider language tags. */
const BING_LANGUAGES = {
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hant': 'zh-Hant',
}

/** Largest request body accepted from the browser, in bytes. */
const MAX_BODY_BYTES = 256 * 1024
/** Segments accepted per call. */
const MAX_SEGMENTS = 8
/** UTF-16 code units accepted per segment (mirrors the upstream translator). */
const MAX_TEXT_CHARS = 4000
/** Durable cache bound. */
const MAX_CACHE_ENTRIES = 5000
/** Default request deadline. */
const TIMEOUT_MS = 10_000
/** Largest diagnostic dump accepted from the browser, in bytes. */
const MAX_DIAG_BYTES = 512 * 1024
/** Diagnostic dumps retained on disk; older ones are pruned. */
const MAX_DIAG_FILES = 60

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** Resolve the harness home (`$DSH_HOME`, else `~/.dsh`). */
function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Directory holding this plugin's durable files. */
function dataDirectory() {
  return join(harnessHome(), 'dsh-thinking-zh')
}

const stateFile = () => join(dataDirectory(), 'state.json')
const cacheFile = () => join(dataDirectory(), 'cache.json')
const diagDirectory = () => join(dataDirectory(), 'diag')

/** Durable preferences; `null` until first read. */
let preferences = null
/** Durable translation cache; `null` until first read. */
let cache = null
/** Pending cache flush. */
let flushTimer = null
let flushDirty = false

/** Normalize one target language tag for a provider. */
export function providerLanguage(target, provider) {
  const lower = String(target).toLowerCase()
  if (provider === 'bing' && BING_LANGUAGES[lower] !== undefined) return BING_LANGUAGES[lower]
  return lower
}

/** Cache key for one exact request. */
export function cacheKey(provider, target, text) {
  return createHash('sha256').update(`${provider}\u0000${target}\u0000${text}`).digest('hex')
}

/** Read durable preferences, falling back to defaults. */
async function readPreferences() {
  if (preferences !== null) return preferences
  let stored = {}
  try {
    const parsed = JSON.parse(await readFile(stateFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') stored = parsed
  } catch { /* absent or unreadable: defaults */ }
  preferences = {
    enabled: stored.enabled !== false,
    targetLanguage: typeof stored.targetLanguage === 'string' && stored.targetLanguage !== ''
      ? stored.targetLanguage
      : 'zh-Hans',
    provider: stored.provider === 'google' ? 'google' : 'bing',
  }
  return preferences
}

/** Persist preferences atomically; memory adopts the new value only after the write lands. */
async function writePreferences(next) {
  const target = stateFile()
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`
  await writeFile(temporary, `${JSON.stringify({ ...next, rev: Date.now() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  preferences = next
}

/** Load the durable cache once. */
async function readCache() {
  if (cache !== null) return cache
  cache = new Map()
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') cache.set(key, value)
      }
    }
  } catch { /* absent or unreadable: start empty */ }
  return cache
}

/** Schedule one debounced durable flush of the cache. */
function scheduleFlush() {
  flushDirty = true
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushCache()
  }, 2000)
  flushTimer.unref?.()
}

/** Write the cache to disk, trimming the oldest entries past the bound. */
async function flushCache() {
  if (!flushDirty || cache === null) return
  flushDirty = false
  try {
    const entries = [...cache.entries()]
    const kept = entries.length > MAX_CACHE_ENTRIES ? entries.slice(entries.length - MAX_CACHE_ENTRIES) : entries
    if (kept.length !== entries.length) cache = new Map(kept)
    await mkdir(dataDirectory(), { recursive: true })
    const target = cacheFile()
    const temporary = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(kept))}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  } catch { /* cache is an optimization: never surface a failure */ }
}

/** Remember one successful translation. */
function remember(key, translation) {
  if (cache === null) cache = new Map()
  cache.delete(key)
  cache.set(key, translation)
  scheduleFlush()
}

/** POST one batch to Bing and return translations in input order. */
async function translateBing(texts, target, signal) {
  const url = new URL(PROVIDERS.bing)
  url.searchParams.set('to', providerLanguage(target, 'bing'))
  url.searchParams.set('isEnterpriseClient', 'false')
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(texts),
    signal,
  })
  if (!response.ok) throw new Error(`bing HTTP ${String(response.status)}`)
  const payload = await response.json()
  if (!Array.isArray(payload) || payload.length !== texts.length) {
    throw new Error('bing: unexpected response shape')
  }
  return payload.map((entry, index) => {
    const text = entry?.translations?.[0]?.text
    if (typeof text !== 'string' || text === '') throw new Error(`bing: segment ${String(index)} has no translation`)
    return text
  })
}

/** POST one batch to the Google anonymous endpoint and return translations in input order. */
async function translateGoogle(texts, target, signal) {
  const translations = []
  for (const text of texts) {
    const form = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: providerLanguage(target, 'google'), dt: 't', q: text })
    const response = await fetch(PROVIDERS.google, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal,
    })
    if (!response.ok) throw new Error(`google HTTP ${String(response.status)}`)
    const payload = await response.json()
    const joined = Array.isArray(payload?.[0])
      ? payload[0].map((piece) => (typeof piece?.[0] === 'string' ? piece[0] : '')).join('')
      : ''
    if (joined === '') throw new Error('google: unexpected response shape')
    translations.push(joined)
  }
  return translations
}

/**
 * Translate one batch, reusing durable results and coalescing concurrent work.
 * @param segments - `{ id, text }` items; order is preserved in the result.
 * @param options - target language, provider and an abort signal.
 * @returns one result per segment; a failed segment carries `text: null`.
 */
export async function translateSegments(segments, options) {
  const { targetLanguage, provider, signal } = options
  const store = await readCache()
  const results = new Array(segments.length).fill(null)
  /** Unique uncached texts, in first-seen order: one upstream request per call. */
  const missing = []
  const missingKeys = new Set()
  const slots = new Map()

  segments.forEach((segment, index) => {
    const key = cacheKey(provider, targetLanguage, segment.text)
    const hit = store.get(key)
    if (typeof hit === 'string') {
      results[index] = { id: segment.id, text: hit, cached: true }
      return
    }
    if (!missingKeys.has(key)) {
      missingKeys.add(key)
      missing.push(segment.text)
      slots.set(key, [])
    }
    slots.get(key).push(index)
  })

  if (missing.length > 0) {
    /** One textual result per unique text, or an Error for the whole batch. */
    let translated
    try {
      translated = provider === 'google'
        ? await translateGoogle(missing, targetLanguage, signal)
        : await translateBing(missing, targetLanguage, signal)
    } catch (error) {
      translated = error
    }
    missing.forEach((text, order) => {
      const key = cacheKey(provider, targetLanguage, text)
      const indexes = slots.get(key) ?? []
      const value = translated instanceof Error ? undefined : translated[order]
      for (const index of indexes) {
        results[index] = value === undefined
          ? {
            id: segments[index].id,
            text: null,
            error: translated instanceof Error ? translated.message : 'translation failed',
          }
          : { id: segments[index].id, text: value, cached: false }
      }
      if (value !== undefined) remember(key, value)
    })
  }

  await flushCache()
  return results
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, { ...JSON_HEADERS })
  res.end(JSON.stringify(body))
}

/**
 * Whether a parsed hostname names this machine's loopback interface.
 *
 * Only an exact `localhost`, the IPv6 loopback literal, or a dotted-quad IPv4
 * address inside 127.0.0.0/8 qualifies. Names such as `127.0.0.1.nip.io` also
 * resolve to loopback, but a browser reaching us under such a *name* is exactly
 * the DNS-rebinding shape this guard must refuse.
 * @param hostname - `URL#hostname` (IPv6 literals keep their brackets).
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost') return true
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (bare === '::1') return true
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (parts === null) return false
  if (parts.slice(1).some((part) => Number(part) > 255)) return false
  return Number(parts[1]) === 127
}

/** Whether a request names a loopback authority with same-origin browser markers. */
function isAllowed(request) {
  const address = request.socket?.remoteAddress ?? ''
  const loopback = address === '::1' || address === '::ffff:127.0.0.1'
    || /^127\./.test(address) || /^::ffff:127\./.test(address)
  if (!loopback) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a bounded request body. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.byteLength
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Method + trust guard. */
function guard(request, response, method) {
  if (!isAllowed(request)) {
    writeJson(response, 403, { error: 'forbidden: loopback same-origin only' })
    return false
  }
  if (request.method !== method) {
    writeJson(response, 405, { error: `method not allowed: ${String(request.method)}` })
    return false
  }
  return true
}

/** Build the complete route list for this plugin instance. */
export function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: ROUTES.state,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        try {
          const current = await readPreferences()
          writeJson(response, 200, { ...current, rev: Date.now() })
        } catch (error) {
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.set,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = JSON.parse(await readBody(request))
          const current = await readPreferences()
          const next = {
            enabled: typeof body?.enabled === 'boolean' ? body.enabled : current.enabled,
            targetLanguage: typeof body?.targetLanguage === 'string' && body.targetLanguage !== ''
              ? body.targetLanguage
              : current.targetLanguage,
            provider: body?.provider === 'google' || body?.provider === 'bing' ? body.provider : current.provider,
          }
          await writePreferences(next)
          writeJson(response, 200, { ...next, rev: Date.now() })
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.translate,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        let body
        try {
          body = JSON.parse(await readBody(request))
        } catch {
          writeJson(response, 400, { error: 'request body must be a JSON object' })
          return
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('translation timeout')), TIMEOUT_MS)
        try {
          const current = await readPreferences()
          if (!current.enabled) {
            writeJson(response, 200, { results: [] })
            return
          }
          const raw = body?.segments
          if (!Array.isArray(raw) || raw.length === 0) {
            writeJson(response, 400, { error: 'segments must be a non-empty array' })
            return
          }
          if (raw.length > MAX_SEGMENTS) {
            writeJson(response, 400, { error: `at most ${String(MAX_SEGMENTS)} segments per request` })
            return
          }
          const segments = []
          for (const entry of raw) {
            const id = typeof entry?.id === 'string' || typeof entry?.id === 'number' ? String(entry.id) : ''
            const text = typeof entry?.text === 'string' ? entry.text : ''
            if (id === '') {
              writeJson(response, 400, { error: 'every segment needs an id' })
              return
            }
            if (text.length > MAX_TEXT_CHARS) {
              writeJson(response, 400, { error: `segment ${id} exceeds ${String(MAX_TEXT_CHARS)} characters` })
              return
            }
            segments.push({ id, text: text.trim() })
          }
          const targetLanguage = typeof body?.targetLanguage === 'string' && body.targetLanguage !== ''
            ? body.targetLanguage
            : current.targetLanguage
          // Empty segments need no network hop.
          const results = []
          const pending = []
          segments.forEach((segment, index) => {
            if (segment.text === '') results[index] = { id: segment.id, text: '', cached: true }
            else pending.push({ index, segment })
          })
          const translated = await translateSegments(pending.map((entry) => entry.segment), {
            targetLanguage,
            provider: current.provider,
            signal: controller.signal,
          })
          pending.forEach((entry, order) => {
            results[entry.index] = translated[order]
          })
          writeJson(response, 200, { results, provider: current.provider, targetLanguage })
        } catch (error) {
          writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        } finally {
          clearTimeout(timer)
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.diag,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = JSON.parse(await readBody(request))
          const rawName = typeof body?.name === 'string' ? body.name : 'dump'
          const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
          const serialized = `${JSON.stringify(body?.payload ?? null, null, 2)}\n`
          // A diagnostic dump carries page structure, which includes transcript
          // text: keep it bounded, mode-restricted and pruned like any other
          // user-content artifact rather than letting it accumulate.
          if (serialized.length > MAX_DIAG_BYTES) {
            writeJson(response, 413, { error: `diag payload exceeds ${String(MAX_DIAG_BYTES)} bytes` })
            return
          }
          await mkdir(diagDirectory(), { recursive: true })
          const target = join(diagDirectory(), `${safeName}.json`)
          await writeFile(target, serialized, { encoding: 'utf8', mode: 0o600 })
          await pruneDiagnostics()
          writeJson(response, 200, { ok: true, path: target })
        } catch (error) {
          writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/** Delete the oldest diagnostic dumps past the retention bound. */
async function pruneDiagnostics() {
  try {
    const { readdir, rm, stat } = await import('node:fs/promises')
    const entries = await readdir(diagDirectory(), { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(diagDirectory(), entry.name)
      files.push({ path, modified: (await stat(path)).mtimeMs })
    }
    if (files.length <= MAX_DIAG_FILES) return
    files.sort((left, right) => left.modified - right.modified)
    for (const file of files.slice(0, files.length - MAX_DIAG_FILES)) await rm(file.path, { force: true })
  } catch { /* diagnostics are best effort */ }
}

/**
 * Mount the translation routes.
 * @param ctx - host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = makeRoutes().map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      if (flushTimer !== null) clearTimeout(flushTimer)
    }
  }, 'dsh-thinking-zh: translation routes')
}
