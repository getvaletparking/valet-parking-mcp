/**
 * Vitest suite for src/mcp/referral-token.ts (mint + KV writer).
 * Plan 10.4-05 Task 3 (file 4 of 4).
 *
 * Covers:
 *   1. mintReferralToken returns 16-char string matching /^[A-Za-z0-9_-]{16}$/
 *      (D-10.4-07: URL-safe base64url derived from 12 random bytes)
 *   2. mintReferralToken produces different tokens on consecutive calls
 *      (sanity: crypto.getRandomValues is not a constant)
 *   3. writeReferralKv writes mcp:referral:${token} with 30-day TTL and
 *      JSON value containing slug + session_id + minted_at fields
 */
import { describe, it, expect } from 'vitest'
import { mintReferralToken, writeReferralKv } from '../referral-token.js'
import type { Env } from '../../types.js'

function createKvStub() {
  const store = new Map<string, string>()
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

describe('referral-token', () => {
  it('mintReferralToken returns 16-char URL-safe base64url string', () => {
    const token = mintReferralToken()
    expect(token).toHaveLength(16)
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('mintReferralToken produces different tokens on consecutive calls', () => {
    const a = mintReferralToken()
    const b = mintReferralToken()
    expect(a).not.toBe(b)
  })

  it('writeReferralKv writes mcp:referral:${token} with 30-day TTL + slug/session_id/minted_at', async () => {
    const { kv, store, ttls } = createKvStub()
    const token = 'abcdefghij012345'
    await writeReferralKv(makeEnv(kv), token, 'classy-valet-service', 'sess-1')
    const raw = store.get(`mcp:referral:${token}`)
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw as string) as {
      slug: string
      session_id: string
      minted_at: number
    }
    expect(parsed.slug).toBe('classy-valet-service')
    expect(parsed.session_id).toBe('sess-1')
    expect(typeof parsed.minted_at).toBe('number')
    // 30-day TTL = 60 * 60 * 24 * 30 seconds = 2592000 per D-10.4-07
    expect(ttls.get(`mcp:referral:${token}`)).toBe(2592000)
  })
})
