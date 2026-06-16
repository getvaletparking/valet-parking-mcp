/**
 * Vitest suite for src/mcp/abuse-circuit.ts (per-IP-per-day tarpit gate).
 * Plan 10.4-05 Task 3 (file 3 of 4).
 *
 * Covers:
 *   1. isTarpitted returns true on non-null tarpit KV
 *   2. isTarpitted returns false on null tarpit KV
 *   3. bumpDailyAndCheckTrip below trip threshold returns tripped:false
 *   4. bumpDailyAndCheckTrip above threshold today AND yesterday returns
 *      tripped:true and writes mcp:tarpit:${ip} with 86400s TTL
 */
import { describe, it, expect } from 'vitest'
import { isTarpitted, bumpDailyAndCheckTrip } from '../abuse-circuit.js'
import type { Env } from '../../types.js'

function createKvStub(initialEntries: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialEntries))
  const ttls = new Map<string, number>()
  return {
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (
        key: string,
        value: string,
        opts?: { expirationTtl?: number },
      ) => {
        store.set(key, value)
        if (opts?.expirationTtl !== undefined) {
          ttls.set(key, opts.expirationTtl)
        }
      },
      delete: async (key: string) => {
        store.delete(key)
      },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace,
    store,
    ttls,
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

describe('abuse-circuit', () => {
  it('isTarpitted returns true on non-null tarpit KV', async () => {
    const { kv } = createKvStub({ 'mcp:tarpit:1.2.3.4': '1' })
    expect(await isTarpitted(makeEnv(kv), '1.2.3.4')).toBe(true)
  })

  it('isTarpitted returns false on null tarpit KV', async () => {
    const { kv } = createKvStub({})
    expect(await isTarpitted(makeEnv(kv), '1.2.3.4')).toBe(false)
  })

  it('below trip threshold: bumpDailyAndCheckTrip returns tripped:false', async () => {
    const { kv } = createKvStub({})
    const result = await bumpDailyAndCheckTrip(makeEnv(kv), '1.2.3.4')
    expect(result.tripped).toBe(false)
  })

  it('above trip threshold today AND yesterday: tripped:true + writes tarpit with 86400s TTL', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const yesterday = yesterdayDate.toISOString().slice(0, 10)
    const { kv, store, ttls } = createKvStub({
      // today is at threshold; +1 trips
      [`mcp:daily:1.2.3.4:${today}`]: '1000',
      [`mcp:daily:1.2.3.4:${yesterday}`]: '1500',
    })
    const result = await bumpDailyAndCheckTrip(makeEnv(kv), '1.2.3.4')
    expect(result.tripped).toBe(true)
    expect(store.get('mcp:tarpit:1.2.3.4')).toBe('1')
    // 24h TTL = 86400 seconds per D-10.4-08
    expect(ttls.get('mcp:tarpit:1.2.3.4')).toBe(86400)
  })
})
