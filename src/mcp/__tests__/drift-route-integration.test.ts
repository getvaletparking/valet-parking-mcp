/**
 * Vitest suite for Phase 10.5 QUAL-09 route-layer integration.
 *
 * Drives the actual Hono mcpPostHandler via direct fetch invocation
 * so the STEP B2 drift-error 503 gate + post-handleRequest warning
 * injection are verified end-to-end (NOT just the helper unit tests).
 *
 * Covers:
 *   - Baseline (level=ok): tools/call -> 200, no warning stamped (Test 1)
 *   - Warning band (level=warning): tools/call -> 200, data_freshness.warning
 *     injected with drift_pct + literal message (Test 2)
 *   - Error band (level=error): tools/call -> 503 + JSON-RPC -32099 +
 *     data.code='drift_detected' + Retry-After: 300 (Test 3)
 *   - D-10.5-07 blanket scope: level=error STILL allows tools/list +
 *     initialize through (Tests 4 + 5)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { _resetDriftFlagCache, type DriftFlag } from '../drift-flag.js'
import { _resetToolFlagsCache } from '../tool-flags.js'
import { setMcpEnv } from '../env-context.js'
import type { Env } from '../../types.js'
import app from '../../index.js'

function createKvStub(driftFlag: DriftFlag | null) {
  const store = new Map<string, string>()
  if (driftFlag !== null) {
    store.set('mcp:drift_flag', JSON.stringify(driftFlag))
  }
  store.set('mcp:tool_flags', JSON.stringify({ tools: {} }))
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
  return kv
}

function makeEnv(kv: KVNamespace): Env {
  return {
    RATE_LIMIT: kv,
    PAYLOAD_URL: 'https://backend.example',
    PUBLIC_TYPESENSE_HOST: 'typesense.example',
    PUBLIC_TYPESENSE_SEARCH_KEY: 'test-key',
    PAYLOAD_API_KEY_NEWSLETTER: 'unused',
    PAYLOAD_API_KEY_DELETION: 'unused',
    TURNSTILE_SECRET_KEY: 'unused',
    WORKER_INGRESS_SECRET: 'unused',
    PAYLOAD_API_BASE_URL: 'https://backend.example',
    PAYLOAD_API_KEY_BUILDER: 'unused',
    PAYLOAD_API_KEY_EXTENSION: 'unused',
  }
}

async function postMcp(env: Env, body: Record<string, unknown>): Promise<Response> {
  const request = new Request('https://api.example/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      'Mcp-Session-Id': 'drift-test-session',
      'cf-connecting-ip': '127.0.0.1',
    },
    body: JSON.stringify(body),
  })
  // app.fetch shape per Hono: (request, env, executionCtx)
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return app.fetch(request, env, executionCtx)
}

describe('drift route integration (Phase 10.5 QUAL-09)', () => {
  beforeEach(() => {
    _resetDriftFlagCache()
    _resetToolFlagsCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('baseline ok: tools/call returns 200, no data_freshness.warning stamped', async () => {
    const kv = createKvStub({
      level: 'ok',
      drift_pct: 0,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 0,
    })
    const env = makeEnv(kv)
    setMcpEnv(env)

    const res = await postMcp(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'valet_list_services', arguments: {} },
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result?: { structuredContent?: { data_freshness?: { warning?: unknown } } }
    }
    expect(json.result?.structuredContent?.data_freshness?.warning).toBeUndefined()
  })

  it('warning band (3.5%): tools/call returns 200 + data_freshness.warning injected with literal message + drift_pct', async () => {
    const kv = createKvStub({
      level: 'warning',
      drift_pct: 3.5,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 35,
    })
    const env = makeEnv(kv)
    setMcpEnv(env)

    const res = await postMcp(env, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'valet_list_services', arguments: {} },
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result?: {
        structuredContent?: {
          data_freshness?: { warning?: { message?: string; drift_pct?: number } }
        }
      }
    }
    expect(json.result?.structuredContent?.data_freshness?.warning).toBeDefined()
    expect(json.result?.structuredContent?.data_freshness?.warning?.message).toBe(
      'Operator data is reconciling; results may be slightly stale',
    )
    expect(json.result?.structuredContent?.data_freshness?.warning?.drift_pct).toBe(3.5)
  })

  it('error band (7.2%): tools/call returns 503 + JSON-RPC -32099 + data.code drift_detected + Retry-After 300', async () => {
    const kv = createKvStub({
      level: 'error',
      drift_pct: 7.2,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 72,
    })
    const env = makeEnv(kv)
    setMcpEnv(env)

    const res = await postMcp(env, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'valet_list_services', arguments: {} },
    })

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('300')
    const json = (await res.json()) as {
      jsonrpc?: string
      error?: { code?: number; message?: string; data?: { code?: string } }
      id?: number | null
    }
    expect(json.jsonrpc).toBe('2.0')
    expect(json.error?.code).toBe(-32099)
    expect(json.error?.message).toBe(
      'Operator data is currently rebuilding. Please retry in 5 minutes.',
    )
    expect(json.error?.data?.code).toBe('drift_detected')
    expect(json.id).toBe(3)
  })

  it('D-10.5-07 blanket scope: tools/list STILL returns 200 when drift level=error', async () => {
    const kv = createKvStub({
      level: 'error',
      drift_pct: 7.2,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 72,
    })
    const env = makeEnv(kv)
    setMcpEnv(env)

    const res = await postMcp(env, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    })

    expect(res.status).toBe(200) // NOT 503; tools/list pass-through per D-10.5-07
  })

  it('D-10.5-07 blanket scope: initialize STILL returns 200 when drift level=error', async () => {
    const kv = createKvStub({
      level: 'error',
      drift_pct: 7.2,
      computed_at: '2026-06-15T12:00:00.000Z',
      payload_count: 1000,
      drift_count: 72,
    })
    const env = makeEnv(kv)
    setMcpEnv(env)

    const res = await postMcp(env, {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0.0.0' },
      },
    })

    expect(res.status).toBe(200) // NOT 503; initialize pass-through per D-10.5-07
  })
})
