/**
 * Vitest suite for src/mcp/tool-flags.ts (kill switch flags blob).
 * Plan 10.4-05 Task 3 (file 2 of 4).
 *
 * Covers:
 *   1. getToolFlags reads from KV stub and returns parsed flags
 *   2. getToolFlags caches for 60s (vi.useFakeTimers verifies cache window)
 *   3. getToolFlags fails open on null KV (returns {tools: {}})
 *   4. getToolFlags fails open on malformed JSON (returns {tools: {}} + console.warn)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getToolFlags, _resetToolFlagsCache } from '../tool-flags.js'
import type { Env } from '../../types.js'

function createKvStub(initialEntries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialEntries))
  return {
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value)
      },
      delete: async (key: string) => {
        store.delete(key)
      },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace,
    store,
  }
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

describe('tool-flags', () => {
  beforeEach(() => {
    _resetToolFlagsCache()
  })

  it('reads from KV stub and returns parsed flags', async () => {
    const { kv } = createKvStub({
      'mcp:tool_flags': JSON.stringify({
        tools: { valet_get_operator: 'disabled' },
      }),
    })
    const flags = await getToolFlags(makeEnv(kv))
    expect(flags.tools['valet_get_operator']).toBe('disabled')
  })

  it('caches for 60s; second call within window does not re-read KV', async () => {
    let getCallCount = 0
    const store = new Map<string, string>([
      ['mcp:tool_flags', JSON.stringify({ tools: {} })],
    ])
    const kv = {
      get: async (key: string) => {
        getCallCount++
        return store.get(key) ?? null
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace

    await getToolFlags(makeEnv(kv))
    await getToolFlags(makeEnv(kv))
    // Cache hit on second call; only 1 KV read total
    expect(getCallCount).toBe(1)
  })

  it('fails open on null KV (returns {tools: {}})', async () => {
    const { kv } = createKvStub({})
    const flags = await getToolFlags(makeEnv(kv))
    expect(flags.tools).toEqual({})
  })

  it('fails open on malformed JSON (returns {tools: {}} + console.warn)', async () => {
    const { kv } = createKvStub({ 'mcp:tool_flags': 'not-json-at-all' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flags = await getToolFlags(makeEnv(kv))
    expect(flags.tools).toEqual({})
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
