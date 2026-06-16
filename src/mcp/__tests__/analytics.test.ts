/**
 * Vitest suite for src/mcp/analytics.ts.
 * Plan 10.4-05 Task 3 (file 1 of 4).
 *
 * Covers:
 *   1. UA_PATTERNS has 5 entries in locked order (D-10.4-13)
 *   2. classifyUA matches Claude/Cursor/ChatGPT/Continue/Cline correctly
 *   3. classifyUA returns 'other' for unmatched UA strings
 *   4. bumpToolCounter increments KV stub idempotently
 *   5. writeAnalytics fires all 3 writes (tool counter + session + client mix)
 */
import { describe, it, expect } from 'vitest'
import {
  classifyUA,
  bumpToolCounter,
  writeAnalytics,
  UA_PATTERNS,
} from '../analytics.js'

function createKvStub() {
  const store = new Map<string, string>()
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

describe('analytics', () => {
  it('UA_PATTERNS contains 5 entries in locked order (D-10.4-13)', () => {
    expect(UA_PATTERNS).toHaveLength(5)
    expect(UA_PATTERNS[0][1]).toBe('claude-desktop')
    expect(UA_PATTERNS[1][1]).toBe('cursor')
    expect(UA_PATTERNS[2][1]).toBe('chatgpt')
    expect(UA_PATTERNS[3][1]).toBe('continue')
    expect(UA_PATTERNS[4][1]).toBe('cline')
  })

  it('classifyUA matches Claude/Cursor/ChatGPT/Continue/Cline', () => {
    expect(classifyUA('Claude Desktop/1.0')).toBe('claude-desktop')
    expect(classifyUA('Cursor/0.42')).toBe('cursor')
    expect(classifyUA('ChatGPT/0.1')).toBe('chatgpt')
    expect(classifyUA('Continue/0.1')).toBe('continue')
    expect(classifyUA('Cline/0.1')).toBe('cline')
  })

  it('classifyUA returns other for unmatched', () => {
    expect(classifyUA('SomeRandomAgent/1.0')).toBe('other')
    expect(classifyUA('')).toBe('other')
    expect(classifyUA('curl/8.7.1')).toBe('other')
  })

  it('bumpToolCounter increments per-tool per-day counter', async () => {
    const { kv, store } = createKvStub()
    await bumpToolCounter(kv, 'valet_get_operator', '2026-06-14')
    await bumpToolCounter(kv, 'valet_get_operator', '2026-06-14')
    expect(store.get('mcp:analytics:2026-06-14:valet_get_operator')).toBe('2')
  })

  it('writeAnalytics fires all 3 writes (tool counter + session + client mix)', async () => {
    const { kv, store } = createKvStub()
    await writeAnalytics(kv, 'valet_get_operator', 'Claude Desktop/1.0', 'sess-1')
    // 3 keys should now exist: mcp:analytics:*, mcp:sessions:*, mcp:client_mix:*
    expect(Array.from(store.keys()).some((k) => k.startsWith('mcp:analytics:'))).toBe(true)
    expect(Array.from(store.keys()).some((k) => k.startsWith('mcp:sessions:'))).toBe(true)
    expect(Array.from(store.keys()).some((k) => k.startsWith('mcp:client_mix:'))).toBe(true)
    // client_mix bucket should be claude-desktop (Claude Desktop UA)
    expect(
      Array.from(store.keys()).some((k) => k.includes('claude-desktop')),
    ).toBe(true)
  })
})
