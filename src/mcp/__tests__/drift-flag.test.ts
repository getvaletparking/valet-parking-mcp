/**
 * Vitest suite for Phase 10.5 drift-flag reader.
 *
 * Covers:
 *   - Happy path: KV blob parses + returns DriftFlag
 *   - 60s in-isolate cache: 2 calls within window cause only 1 KV read
 *   - Fail-open on null KV (OK_FALLBACK)
 *   - Fail-open on malformed JSON (OK_FALLBACK + console.warn)
 *   - Fail-open on shape mismatch (OK_FALLBACK)
 *   - Fail-open on non-numeric drift_pct (OK_FALLBACK)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getDriftFlag, _resetDriftFlagCache, type DriftFlag } from '../drift-flag.js'
import type { Env } from '../../types.js'

function createKvStub(initialEntries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialEntries))
  let getCallCount = 0
  const kv = {
    get: async (key: string) => {
      getCallCount++
      return store.get(key) ?? null
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
  return { kv, store, getCallCount: () => getCallCount }
}

function makeEnv(kv: KVNamespace): Env {
  return {
    RATE_LIMIT: kv,
    PAYLOAD_URL: '',
    PUBLIC_TYPESENSE_HOST: '',
    PUBLIC_TYPESENSE_SEARCH_KEY: '',
    PAYLOAD_API_KEY_NEWSLETTER: '',
    PAYLOAD_API_KEY_DELETION: '',
    TURNSTILE_SECRET_KEY: '',
    WORKER_INGRESS_SECRET: '',
    PAYLOAD_API_BASE_URL: '',
    PAYLOAD_API_KEY_BUILDER: '',
    PAYLOAD_API_KEY_EXTENSION: '',
  }
}

describe('getDriftFlag', () => {
  beforeEach(() => {
    _resetDriftFlagCache()
  })

  it('reads from KV stub and returns the parsed DriftFlag', async () => {
    const flag: DriftFlag = {
      level: 'warning',
      drift_pct: 3.5,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 35,
    }
    const { kv } = createKvStub({ 'mcp:drift_flag': JSON.stringify(flag) })
    const result = await getDriftFlag(makeEnv(kv))
    expect(result).toEqual(flag)
  })

  it('caches the read for 60s; second call within window does not re-read KV', async () => {
    const flag: DriftFlag = {
      level: 'ok',
      drift_pct: 0,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 0,
    }
    const { kv, getCallCount } = createKvStub({
      'mcp:drift_flag': JSON.stringify(flag),
    })
    await getDriftFlag(makeEnv(kv))
    await getDriftFlag(makeEnv(kv))
    expect(getCallCount()).toBe(1)
  })

  it('fails open on null KV (returns OK_FALLBACK)', async () => {
    const { kv } = createKvStub({})
    const result = await getDriftFlag(makeEnv(kv))
    expect(result.level).toBe('ok')
    expect(result.computed_at).toBe('1970-01-01T00:00:00.000Z')
    expect(result.payload_count).toBe(0)
    expect(result.drift_count).toBe(0)
    expect(result.drift_pct).toBe(0)
  })

  it('fails open on malformed JSON (returns OK_FALLBACK + console.warn)', async () => {
    const { kv } = createKvStub({ 'mcp:drift_flag': 'not-valid-json-at-all' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await getDriftFlag(makeEnv(kv))
    expect(result.level).toBe('ok')
    expect(result.computed_at).toBe('1970-01-01T00:00:00.000Z')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('fails open on shape validation failure (returns OK_FALLBACK + console.warn)', async () => {
    const { kv } = createKvStub({
      'mcp:drift_flag': JSON.stringify({
        level: 'unknown_bucket', // not in DriftLevel enum
        drift_pct: 3.5,
        computed_at: '2026-06-15T12:00:00.000Z',
        payload_count: 1000,
        drift_count: 35,
      }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await getDriftFlag(makeEnv(kv))
    expect(result.level).toBe('ok')
    expect(result.computed_at).toBe('1970-01-01T00:00:00.000Z')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('fails open when drift_pct is non-numeric', async () => {
    const { kv } = createKvStub({
      'mcp:drift_flag': JSON.stringify({
        level: 'warning',
        drift_pct: 'three point five', // string, not number
        computed_at: '2026-06-15T12:00:00.000Z',
        payload_count: 1000,
        drift_count: 35,
      }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await getDriftFlag(makeEnv(kv))
    expect(result.level).toBe('ok')
    warnSpy.mockRestore()
  })
})
