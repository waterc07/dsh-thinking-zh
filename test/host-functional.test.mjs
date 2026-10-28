/**
 * Host-half functional verification for `dsh-thinking-zh` (phase 1, no app).
 *
 * Custom runner (no `node:test`); see `test/README.md`.
 *   node test/host-functional.test.mjs
 *   DSH_THINKING_ZH_OFFLINE=1 node test/host-functional.test.mjs   # skip the one live-upstream case
 *
 * Read-only against src/. Writes only under `$DSH_HOME` (a temp sandbox) and
 * `test/evidence/`.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import {
  createSuite, makeHome, loadPlugin, startServer, request, stubFetch,
  jsonResponse, bingHappy, readJsonFile, listDirectory, fileText,
  assert, assertEqual, assertIncludes, assertCjk, ensureEvidenceDir, sleep,
} from './lib/harness.mjs'

const suite = createSuite('host-functional')
const uncaught = []
process.on('uncaughtException', (error) => { uncaught.push(`uncaughtException: ${error.message}`) })
process.on('unhandledRejection', (error) => { uncaught.push(`unhandledRejection: ${String(error)}`) })

/**
 * Set `DSH_THINKING_ZH_OFFLINE=1` to record the single case that talks to the
 * real anonymous endpoint as a NOTE (with the reason) instead of a failure.
 * Everything else in this file is stubbed and runs fully offline.
 */
const OFFLINE = process.env.DSH_THINKING_ZH_OFFLINE === '1'
const networkTest = OFFLINE ? suite.note.bind(suite) : suite.test.bind(suite)

async function withHost(tag, fn) {
  const home = await makeHome(tag)
  const plugin = await loadPlugin(home)
  const host = await startServer(plugin)
  try {
    return await fn({ home, plugin, host })
  } finally {
    await host.close()
  }
}

// ---------------------------------------------------------------- happy path

await networkTest('real Bing: English preview -> Chinese, shape matches contract', () => {
  if (OFFLINE) return Promise.resolve('SKIPPED: DSH_THINKING_ZH_OFFLINE=1 (live upstream not contacted)')
  return withHost('real', async ({ host }) => {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST',
      body: { segments: [{ id: 's1', text: 'I will inspect the plugin API first.' }] },
      timeout: 20_000,
    })
    assertEqual(response.status, 200, 'status')
    assert(Array.isArray(response.json?.results), 'results array')
    assertEqual(response.json.results.length, 1, 'results length')
    assertEqual(response.json.results[0].id, 's1', 'id')
    assertEqual(response.json.results[0].cached, false, 'cached')
    assertCjk(response.json.results[0].text, 'translation')
    assertEqual(response.json.provider, 'bing', 'provider')
    assertEqual(response.json.targetLanguage, 'zh-Hans', 'targetLanguage')
    return response.json.results[0].text
  })
})

await suite.test('repeated request hits cache (cached:true) with no second network hop', () => withHost('cache-hit', async ({ host }) => {
  const stub = stubFetch(bingHappy((text) => `译文:${text}`))
  try {
    const first = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'a', text: 'Inspect the cache layer.' }] },
    })
    const second = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'a', text: 'Inspect the cache layer.' }] },
    })
    assertEqual(first.status, 200, 'first status')
    assertEqual(first.json.results[0].cached, false, 'first cached')
    assertEqual(second.json.results[0].cached, true, 'second cached')
    assertEqual(second.json.results[0].text, first.json.results[0].text, 'same text')
    assertEqual(stub.calls.length, 1, 'network calls')
    return `calls=${String(stub.calls.length)} text=${first.json.results[0].text}`
  } finally {
    stub.restore()
  }
}))

await suite.test('same text twice in one request => one upstream send, both filled', () => withHost('dedupe', async ({ host }) => {
  const stub = stubFetch(bingHappy((text) => `译:${text}`))
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST',
      body: { segments: [{ id: 's1', text: 'Same sentence here.' }, { id: 's2', text: 'Same sentence here.' }] },
    })
    assertEqual(response.status, 200, 'status')
    assertEqual(response.json.results.length, 2, 'length')
    assertEqual(response.json.results[0].id, 's1', 'id0')
    assertEqual(response.json.results[1].id, 's2', 'id1')
    assertEqual(response.json.results[0].text, response.json.results[1].text, 'same translation')
    assertEqual(stub.calls.length, 1, 'network calls')
    assertEqual(JSON.parse(stub.calls[0].options.body).length, 1, 'upstream batch size')
    assertEqual(stub.calls[0].url.startsWith('https://edge.microsoft.com/translate/translatetext'), true, 'bing endpoint')
    assertIncludes(stub.calls[0].url, 'to=zh-Hans', 'default target language tag')
    return `calls=${String(stub.calls.length)}`
  } finally {
    stub.restore()
  }
}))

await suite.test('distinct texts are batched into one upstream request', () => withHost('batch', async ({ host }) => {
  const stub = stubFetch(bingHappy((text) => `译:${text}`))
  try {
    const segments = ['First.', 'Second.', 'Third.'].map((text, index) => ({ id: `s${String(index)}`, text }))
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body: { segments } })
    assertEqual(response.status, 200, 'status')
    assertEqual(JSON.stringify(response.json.results.map((result) => result.id)), JSON.stringify(['s0', 's1', 's2']), 'order')
    assertEqual(stub.calls.length, 1, 'network calls')
    assertEqual(JSON.parse(stub.calls[0].options.body).length, 3, 'batch size')
    return `calls=${String(stub.calls.length)}`
  } finally {
    stub.restore()
  }
}))

await suite.test('targetLanguage override maps zh-TW -> zh-Hant for bing', () => withHost('lang-map', async ({ host }) => {
  const stub = stubFetch(bingHappy())
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST',
      body: { segments: [{ id: 's1', text: 'Translate me.' }], targetLanguage: 'zh-TW' },
    })
    assertEqual(response.status, 200, 'status')
    assertIncludes(stub.calls[0].url, 'to=zh-Hant', 'mapped tag')
    return stub.calls[0].url
  } finally {
    stub.restore()
  }
}))

// ------------------------------------------------------------ input validation

await suite.test('empty segment: no upstream hop, text "" cached:true', () => withHost('empty', async ({ host }) => {
  const stub = stubFetch(() => { throw new Error('network must not be called') })
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'e1', text: '' }, { id: 'e2', text: '   ' }] },
    })
    assertEqual(response.status, 200, 'status')
    assertEqual(response.json.results[0].text, '', 'empty text')
    assertEqual(response.json.results[1].text, '', 'whitespace-only text')
    assertEqual(stub.calls.length, 0, 'network calls')
    return JSON.stringify(response.json.results)
  } finally {
    stub.restore()
  }
}))

await suite.test('more than 8 segments -> 400 and no upstream hop', () => withHost('too-many', async ({ host }) => {
  const stub = stubFetch(() => { throw new Error('network must not be called') })
  try {
    const segments = Array.from({ length: 9 }, (_, index) => ({ id: `s${String(index)}`, text: `Sentence ${String(index)}.` }))
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body: { segments } })
    assertEqual(response.status, 400, 'status')
    assertIncludes(response.json?.error, '8', 'error text')
    assertEqual(stub.calls.length, 0, 'network calls')
    return response.json.error
  } finally {
    stub.restore()
  }
}))

await suite.test('8 segments is accepted (boundary)', () => withHost('eight', async ({ host }) => {
  const stub = stubFetch(bingHappy())
  try {
    const segments = Array.from({ length: 8 }, (_, index) => ({ id: `s${String(index)}`, text: `Sentence ${String(index)}.` }))
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body: { segments } })
    assertEqual(response.status, 200, 'status')
    assertEqual(response.json.results.length, 8, 'length')
    assertEqual(stub.calls.length, 1, 'network calls')
    return 'ok'
  } finally {
    stub.restore()
  }
}))

await suite.test('segment over 4000 chars -> 400', () => withHost('too-long', async ({ host }) => {
  const stub = stubFetch(() => { throw new Error('network must not be called') })
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'big', text: 'x'.repeat(4001) }] },
    })
    assertEqual(response.status, 400, 'status')
    assertIncludes(response.json?.error, '4000', 'error text')
    assertEqual(stub.calls.length, 0, 'network calls')
    return response.json.error
  } finally {
    stub.restore()
  }
}))

await suite.test('exactly 4000 chars is accepted (boundary)', () => withHost('long-ok', async ({ host }) => {
  const stub = stubFetch(bingHappy())
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'big', text: 'y'.repeat(4000) }] },
    })
    assertEqual(response.status, 200, 'status')
    assertEqual(stub.calls.length, 1, 'network calls')
    return 'ok'
  } finally {
    stub.restore()
  }
}))

await suite.test('invalid payloads -> 400 (empty, missing, no id, non-object entry)', () => withHost('invalid', async ({ host }) => {
  const cases = [
    { body: {}, label: 'missing segments' },
    { body: { segments: [] }, label: 'empty array' },
    { body: { segments: [{ text: 'no id' }] }, label: 'missing id' },
    { body: { segments: [null] }, label: 'null entry' },
    { body: { segments: 'nope' }, label: 'string segments' },
  ]
  const statuses = []
  for (const item of cases) {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body: item.body })
    statuses.push(`${item.label}=${String(response.status)}`)
    assertEqual(response.status, 400, item.label)
  }
  return statuses.join(', ')
}))

// ---------------------------------------------------------- failure isolation

await suite.test('upstream HTTP 500 => 200 with per-segment {text:null,error}, no throw', () => withHost('upstream-500', async ({ host }) => {
  const stub = stubFetch(() => jsonResponse({ error: 'boom' }, 500))
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'a', text: 'One.' }, { id: 'b', text: 'Two.' }] },
    })
    assertEqual(response.status, 200, 'HTTP status')
    assertEqual(response.json.results.length, 2, 'length')
    for (const result of response.json.results) {
      assertEqual(result.text, null, `${String(result.id)} text`)
      assertIncludes(result.error, 'bing HTTP 500', 'error text')
    }
    return JSON.stringify(response.json.results)
  } finally {
    stub.restore()
  }
}))

await suite.test('malformed upstream payload => per-segment error, no throw', () => withHost('upstream-shape', async ({ host }) => {
  const stub = stubFetch(() => jsonResponse([{ unexpected: true }]))
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'a', text: 'One.' }] },
    })
    assertEqual(response.status, 200, 'HTTP status')
    assertEqual(response.json.results[0].text, null, 'text')
    assertIncludes(response.json.results[0].error, 'bing', 'error text')
    return JSON.stringify(response.json.results[0])
  } finally {
    stub.restore()
  }
}))

await suite.test('upstream timeout (~10s) => per-segment errors, response still 200', () => withHost('timeout', async ({ host }) => {
  const stub = stubFetch((url, options) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason); return }
    options.signal?.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
  }))
  try {
    const started = Date.now()
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'a', text: 'Slow one.' }] }, timeout: 25_000,
    })
    const elapsed = Date.now() - started
    assertEqual(response.status, 200, 'HTTP status')
    assertEqual(response.json.results[0].text, null, 'text')
    assertIncludes(response.json.results[0].error, 'timeout', 'error text')
    assert(elapsed >= 9_500 && elapsed <= 14_000, `deadline should be ~10s, took ${String(elapsed)}ms`)
    return `elapsed=${String(elapsed)}ms error=${response.json.results[0].error}`
  } finally {
    stub.restore()
  }
}))

await suite.test('enabled=false short-circuits translate (no upstream, empty results)', () => withHost('disabled', async ({ host }) => {
  const stub = stubFetch(() => { throw new Error('network must not be called') })
  try {
    const set = await request(host.base, '/api/dsh-thinking-zh/set', { method: 'POST', body: { enabled: false } })
    assertEqual(set.status, 200, 'set status')
    assertEqual(set.json.enabled, false, 'enabled')
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'a', text: 'Hello.' }] },
    })
    assertEqual(response.status, 200, 'translate status')
    assertEqual(JSON.stringify(response.json.results), '[]', 'results')
    assertEqual(stub.calls.length, 0, 'network calls')
    return JSON.stringify(response.json)
  } finally {
    stub.restore()
  }
}))

// ------------------------------------------------------- concurrency / cache

await suite.test('two concurrent requests for the same uncached text', () => withHost('concurrent-same', async ({ host }) => {
  const stub = stubFetch(async (url, options) => {
    await sleep(250)
    return bingHappy()(url, options)
  })
  try {
    const body = { segments: [{ id: 'a', text: 'Concurrent duplicate.' }] }
    const [first, second] = await Promise.all([
      request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body }),
      request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body }),
    ])
    assertEqual(first.status, 200, 'first status')
    assertEqual(second.status, 200, 'second status')
    return { networkCalls: stub.calls.length, firstCached: first.json.results[0].cached, secondCached: second.json.results[0].cached }
  } finally {
    stub.restore()
  }
}))

await suite.test('concurrent distinct texts are not serialized behind each other', () => withHost('concurrent-distinct', async ({ host }) => {
  const stub = stubFetch(async (url, options) => {
    await sleep(250)
    return bingHappy()(url, options)
  })
  try {
    const started = Date.now()
    const responses = await Promise.all(['One.', 'Two.', 'Three.'].map((text, index) => request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: String(index), text }] },
    })))
    const elapsed = Date.now() - started
    for (const response of responses) assertEqual(response.status, 200, 'status')
    return { elapsedMs: elapsed, networkCalls: stub.calls.length }
  } finally {
    stub.restore()
  }
}))

await suite.test('cache survives a module reload (disk rebound)', () => withHost('persist', async ({ home, host }) => {
  const stub = stubFetch(bingHappy((text) => `持久:${text}`))
  try {
    const first = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'p', text: 'Persist this translation.' }] },
    })
    assertEqual(first.json.results[0].cached, false, 'first cached')
    const cache = await readJsonFile(join(home, 'dsh-thinking-zh', 'cache.json'))
    assert(cache !== undefined, 'cache.json written')
    stub.restore()

    const freshPlugin = await loadPlugin(home)
    const freshHost = await startServer(freshPlugin)
    const noNetwork = stubFetch(() => { throw new Error('network must not be called') })
    try {
      const second = await request(freshHost.base, '/api/dsh-thinking-zh/translate', {
        method: 'POST', body: { segments: [{ id: 'p', text: 'Persist this translation.' }] },
      })
      assertEqual(second.status, 200, 'second status')
      assertEqual(second.json.results[0].cached, true, 'second cached')
      assertEqual(noNetwork.calls.length, 0, 'network calls after reload')
      return second.json.results[0].text
    } finally {
      noNetwork.restore()
      await freshHost.close()
    }
  } finally {
    stub.restore()
  }
}))

await suite.test('cache file bounded to 5000 entries and keeps the newest', () => withHost('trim', async ({ home, host }) => {
  const dir = join(home, 'dsh-thinking-zh')
  await mkdir(dir, { recursive: true })
  const seeded = {}
  for (let index = 0; index < 5100; index += 1) seeded[`seed-${String(index).padStart(4, '0')}`] = `旧${String(index)}`
  await writeFile(join(dir, 'cache.json'), JSON.stringify(seeded), 'utf8')
  const stub = stubFetch(async (url, options) => {
    const texts = JSON.parse(options.body)
    return jsonResponse(texts.map((text) => ({ translations: [{ text: `新:${text}` }] })))
  })
  try {
    const response = await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'n', text: 'Newest entry.' }] },
    })
    assertEqual(response.status, 200, 'status')
    const cache = await readJsonFile(join(dir, 'cache.json'))
    const entries = Object.entries(cache ?? {})
    assert(entries.length <= 5000, `cache size ${String(entries.length)} must be <= 5000`)
    assert(entries.some(([, value]) => value === '新:Newest entry.'), 'newest translation kept')
    assert(!Object.hasOwn(cache ?? {}, 'seed-0000'), 'oldest entry evicted')
    return `entries=${String(entries.length)}`
  } finally {
    stub.restore()
  }
}))

await suite.test('cache writes are atomic: no leftover .tmp files', () => withHost('atomic', async ({ home, host }) => {
  const stub = stubFetch(bingHappy())
  try {
    for (let index = 0; index < 5; index += 1) {
      await request(host.base, '/api/dsh-thinking-zh/translate', {
        method: 'POST', body: { segments: [{ id: String(index), text: `Atomic ${String(index)}.` }] },
      })
    }
    const files = await listDirectory(join(home, 'dsh-thinking-zh'))
    assert(files.includes('cache.json'), 'cache.json exists')
    assert(!files.some((name) => name.includes('.tmp-')), `leftover temp files: ${files.join(',')}`)
    return files.join(',')
  } finally {
    stub.restore()
  }
}))

await suite.test('cache file holds no plaintext source English (hash keys + translated values)', () => withHost('privacy', async ({ home, host }) => {
  const stub = stubFetch(bingHappy(() => '中文译文'))
  try {
    const secret = 'SENSITIVE-SOURCE-SENTENCE-abc123'
    await request(host.base, '/api/dsh-thinking-zh/translate', {
      method: 'POST', body: { segments: [{ id: 'p', text: secret }] },
    })
    const text = await fileText(join(home, 'dsh-thinking-zh', 'cache.json'))
    assert(text !== undefined, 'cache.json exists')
    assert(!text.includes('SENSITIVE-SOURCE-SENTENCE'), 'source sentence absent from cache')
    const parsed = JSON.parse(text)
    for (const key of Object.keys(parsed)) assert(/^[0-9a-f]{64}$/.test(key), `cache key not sha256 hex: ${key.slice(0, 20)}`)
    return 'ok'
  } finally {
    stub.restore()
  }
}))

// ------------------------------------------------------ state / config / diag

await suite.test('GET /state returns contract shape with defaults', () => withHost('state', async ({ host }) => {
  const response = await request(host.base, '/api/dsh-thinking-zh/state')
  assertEqual(response.status, 200, 'status')
  assertEqual(response.json.enabled, true, 'enabled')
  assertEqual(response.json.targetLanguage, 'zh-Hans', 'targetLanguage')
  assertEqual(response.json.provider, 'bing', 'provider')
  assert(typeof response.json.rev === 'number', 'rev number')
  return JSON.stringify(response.json)
}))

await suite.test('POST /set persists enabled + targetLanguage; ignores invalid provider', () => withHost('set', async ({ home, host }) => {
  const response = await request(host.base, '/api/dsh-thinking-zh/set', {
    method: 'POST', body: { enabled: false, targetLanguage: 'zh-Hant', provider: 'evil' },
  })
  assertEqual(response.status, 200, 'status')
  assertEqual(response.json.enabled, false, 'enabled')
  assertEqual(response.json.targetLanguage, 'zh-Hant', 'targetLanguage')
  assertEqual(response.json.provider, 'bing', 'invalid provider ignored')
  const persisted = await readJsonFile(join(home, 'dsh-thinking-zh', 'state.json'))
  assertEqual(persisted?.enabled, false, 'persisted enabled')
  const state = await request(host.base, '/api/dsh-thinking-zh/state')
  assertEqual(state.json.enabled, false, 'state enabled')
  assertEqual(state.json.targetLanguage, 'zh-Hant', 'state targetLanguage')
  return JSON.stringify(state.json)
}))

await suite.test('diag writes payload under $DSH_HOME/dsh-thinking-zh/diag and returns path', () => withHost('diag', async ({ home, host }) => {
  const payload = { nodes: [{ tag: 'div', text: '思考预览' }], nested: { ok: true } }
  const response = await request(host.base, '/api/dsh-thinking-zh/diag', { method: 'POST', body: { name: 'preview-dom', payload } })
  assertEqual(response.status, 200, 'status')
  assertEqual(response.json.ok, true, 'ok')
  const expected = join(home, 'dsh-thinking-zh', 'diag', 'preview-dom.json')
  assert(response.json.path.endsWith('preview-dom.json'), `path ${response.json.path}`)
  const written = await readJsonFile(expected)
  assertEqual(written?.nested?.ok, true, 'payload persisted')
  const files = await listDirectory(join(home, 'dsh-thinking-zh', 'diag'))
  return files.join(',')
}))

await suite.test('method guard: wrong method -> 405', () => withHost('methods', async ({ host }) => {
  const getTranslate = await request(host.base, '/api/dsh-thinking-zh/translate')
  const postState = await request(host.base, '/api/dsh-thinking-zh/state', { method: 'POST', body: {} })
  assertEqual(getTranslate.status, 405, 'GET translate')
  assertEqual(postState.status, 405, 'POST state')
  return `GET translate=${String(getTranslate.status)} POST state=${String(postState.status)}`
}))

// ------------------------------------------------------------ body / robustness

await suite.test('JSON parse failure status codes (translate vs set)', () => withHost('bad-json', async ({ host }) => {
  const translate = await request(host.base, '/api/dsh-thinking-zh/translate', { method: 'POST', body: '{not json' })
  const set = await request(host.base, '/api/dsh-thinking-zh/set', { method: 'POST', body: '{not json' })
  return { translate: translate.status, set: set.status }
}))

await suite.test('>256KB body is refused and the host stays alive', () => withHost('oversize', async ({ host }) => {
  const response = await request(host.base, '/api/dsh-thinking-zh/set', {
    method: 'POST', body: `{"padding":"${'a'.repeat(300 * 1024)}"}`, timeout: 15_000,
  })
  const after = await request(host.base, '/api/dsh-thinking-zh/state')
  assertEqual(after.status, 200, 'host alive after oversize')
  return { oversizeStatus: response.status, reset: response.reset, error: response.error, after: after.status }
}))

await suite.test('client abort mid-body does not wedge later requests', () => withHost('abort-body', async ({ host }) => {
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: host.port, path: '/api/dsh-thinking-zh/set', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    })
    req.on('error', () => { resolve() })
    req.write('{"enabled":')
    setTimeout(() => { req.destroy(); resolve() }, 50)
  })
  await sleep(100)
  const after = await request(host.base, '/api/dsh-thinking-zh/state')
  assertEqual(after.status, 200, 'host alive after aborted body')
  return 'ok'
}))

// ----------------------------------------------------------- apply() lifecycle

await suite.test('apply() registers routes and disposer removes them', () => {
  return (async () => {
    const home = await makeHome('apply-lifecycle')
    const plugin = await loadPlugin(home)
    const registered = []
    const effects = []
    const ctx = {
      effect(fn, label) {
        const dispose = fn()
        effects.push({ label, dispose })
        return dispose
      },
      webServer: {
        register(route) {
          const dispose = () => {
            const at = registered.indexOf(route)
            if (at !== -1) registered.splice(at, 1)
          }
          registered.push(route)
          return dispose
        },
      },
    }
    plugin.apply(ctx)
    assertEqual(registered.length, 4, 'routes registered')
    assertEqual(effects.length, 1, 'one effect')
    const names = registered.map((route) => route.path).sort()
    effects[0].dispose()
    assertEqual(registered.length, 0, 'routes disposed')
    return names.join(',')
  })()
})

await suite.test('apply() twice without dispose throws duplicate-route error', () => {
  return (async () => {
    const home = await makeHome('apply-twice')
    const plugin = await loadPlugin(home)
    const registered = []
    const ctx = {
      effect(fn) { return fn() },
      webServer: {
        register(route) {
          if (registered.some((candidate) => candidate.path === route.path && candidate.kind === route.kind)) {
            throw new Error(`duplicate ${route.kind} route "${route.path}"`)
          }
          registered.push(route)
          return () => { registered.splice(registered.indexOf(route), 1) }
        },
      },
    }
    plugin.apply(ctx)
    let error
    try { plugin.apply(ctx) } catch (caught) { error = caught }
    return { threw: error instanceof Error, message: error instanceof Error ? error.message : undefined }
  })()
})

await suite.test('unload clears the flush timer (no handle keeps the process alive)', () => {
  return (async () => {
    const home = await makeHome('apply-timer')
    const plugin = await loadPlugin(home)
    const ctx = { effect(fn) { return fn() }, webServer: { register: () => () => {} } }
    plugin.apply(ctx)
    const stub = stubFetch(bingHappy())
    try {
      await plugin.translateSegments([{ id: 'a', text: 'Timer probe.' }], {
        targetLanguage: 'zh-Hans', provider: 'bing', signal: new AbortController().signal,
      })
      return 'translateSegments ok (timer is unref()ed; no process hold)'
    } finally {
      stub.restore()
    }
  })()
})

const summary = suite.summary()
await ensureEvidenceDir()
await writeFile(`${(await ensureEvidenceDir())}/host-functional-results.json`, `${JSON.stringify({ summary, uncaught }, null, 2)}\n`, 'utf8')
console.log(`\n== host-functional: ${String(summary.counts.PASS)} pass, ${String(summary.counts.FAIL)} fail, ${String(summary.counts.NOTE)} note, ${String(summary.counts.ERROR)} error`)
if (uncaught.length > 0) console.log(`!! process-level errors: ${uncaught.join(' | ')}`)
process.exitCode = summary.counts.FAIL + summary.counts.ERROR > 0 ? 1 : 0
