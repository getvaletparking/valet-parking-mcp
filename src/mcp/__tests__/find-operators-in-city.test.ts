/**
 * Vitest suite for valet_find_operators_in_city (TOOL-04).
 * Plan 10.3-03 Task 1.
 *
 * Mirrors apps/workers/edge-api/src/mcp/__tests__/search-cities.test.ts
 * structure. Tests handler-level invariants by invoking the registered
 * tool against a stubbed globalThis.fetch (per the 10.2 D-10.2 vitest
 * fetch-stub recommendation).
 *
 * Covers:
 *   1. Happy path with service filter (D-10.3-02 URL grammar)
 *   2. Happy path without service filter (services:= absent)
 *   3. Invalid state_slug regex (rejected BEFORE upstream fetch, D-10.3-06)
 *   4. Invalid city_slug regex (rejected BEFORE upstream fetch, D-10.3-06)
 *   5. Invalid service enum (zod parse-time rejection, D-10.3-05 9-slug enumeration)
 *   6. Upstream unavailable on Typesense 500
 *   7. Empty array success per D-10.3-07 (typesense:operators:empty marker)
 *   8. Sort URL verification per D-10.3-04 (updated_at:desc on wire + premium-first client-side reorder)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../server.js'
import { setMcpEnv } from '../env-context.js'
import type { Env } from '../../types.js'

const TEST_ENV: Env = {
  RATE_LIMIT: {} as KVNamespace,
  PAYLOAD_URL: 'https://backend.getvaletparking.com',
  PUBLIC_TYPESENSE_HOST: 'typesense.getvaletparking.com',
  PUBLIC_TYPESENSE_SEARCH_KEY: 'test-search-key',
  PAYLOAD_API_KEY_NEWSLETTER: 'unused',
  PAYLOAD_API_KEY_DELETION: 'unused',
  TURNSTILE_SECRET_KEY: 'unused',
  WORKER_INGRESS_SECRET: 'unused',
  PAYLOAD_API_BASE_URL: 'https://backend.getvaletparking.com',
  PAYLOAD_API_KEY_BUILDER: 'test-builder-key',
  PAYLOAD_API_KEY_EXTENSION: 'test-ext-key',
}

/**
 * Build a Typesense operators hit shape. Matches the helper's mapOperatorSummary
 * input contract (operators.ts mapOperatorSummary).
 */
function buildOperatorHit(overrides: Record<string, unknown> = {}) {
  return {
    document: {
      name: 'Test Operator',
      slug: 'test-operator',
      primary_city_name: 'Houston',
      primary_state_name: 'Texas',
      primary_city_slug: 'houston',
      primary_state_slug: 'texas',
      services: ['hotel-resort-valet', 'general-valet'],
      phone: '(555) 555-0100',
      tier: 'premium',
      description_text: 'Test description.',
      typesense_indexed_at: 1717000000000,
      updated_at: 1716000000000,
      ...overrides,
    },
  }
}

async function newClient() {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'vitest', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

describe('valet_find_operators_in_city tool', () => {
  // Widened spy type to match the search-cities.test.ts pattern; the typed
  // signature of globalThis.fetch carries Cloudflare-Workers-types overloads
  // with non-unknown param types that conflict with vi.SpyInstance generics.
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.fn>
    setMcpEnv(TEST_ENV)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('happy path: returns operators array with service filter applied (D-10.3-02 URL grammar)', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      capturedUrl = url
      if (url.includes('typesense.getvaletparking.com/collections/operators/documents/search')) {
        return new Response(
          JSON.stringify({
            hits: [
              buildOperatorHit(),
              buildOperatorHit({ slug: 'op2', name: 'Op Two', tier: 'paid' }),
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('unexpected fetch URL: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'texas',
        city_slug: 'houston',
        service: 'hotel-resort-valet',
        limit: 10,
      },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: Array<{ name: string; slug: string; tier: string }>
      data_freshness: { indexed_at: string; source: string }
      _meta: { terms: string; attribution: string }
    }
    expect(sc.operators).toHaveLength(2)
    expect(sc.operators[0]).toMatchObject({
      name: 'Test Operator',
      slug: 'test-operator',
      tier: 'premium',
    })
    expect(sc.data_freshness.source).toBe('typesense:operators')
    expect(sc._meta.terms).toBe('https://api.getvaletparking.com/mcp/terms')

    // Verify upstream URL grammar (D-10.3-02 + D-10.3-04)
    expect(decodeURIComponent(capturedUrl)).toContain('service_area_city_slugs:=houston')
    expect(decodeURIComponent(capturedUrl)).toContain('primary_state_slug:=texas')
    expect(decodeURIComponent(capturedUrl)).toContain('services:=hotel-resort-valet')
  })

  it('omits services:= filter when service argument is undefined', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      capturedUrl = url
      if (url.includes('typesense.getvaletparking.com/collections/operators/documents/search')) {
        return new Response(JSON.stringify({ hits: [buildOperatorHit()] }), { status: 200 })
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'texas',
        city_slug: 'houston',
        limit: 10,
      },
    })

    const decoded = decodeURIComponent(capturedUrl)
    expect(decoded).toContain('service_area_city_slugs:=houston')
    expect(decoded).toContain('primary_state_slug:=texas')
    expect(decoded).not.toContain('services:=')
  })

  it('rejects invalid state_slug (uppercase) BEFORE upstream fetch (D-10.3-06)', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called for invalid_input regex rejection')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'TEXAS',
        city_slug: 'houston',
        limit: 10,
      },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text.startsWith('Invalid state_slug:')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid city_slug (spaces) BEFORE upstream fetch (D-10.3-06)', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'texas',
        city_slug: 'New Houston',
        limit: 10,
      },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text.startsWith('Invalid city_slug:')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid service enum with 9-slug enumeration (D-10.3-05)', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called for invalid_input zod rejection')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'texas',
        city_slug: 'houston',
        service: 'wedding-valeting',
        limit: 10,
      },
    })

    // The SDK validator surfaces zod enum errors via an isError envelope.
    // The substantive assertion is that the canonical 9-slug enumeration
    // text leaks through (either via the zod errorMap-driven message or
    // via the SDK's enum-listing wrapper). Both wedding-valet (first) and
    // general-valet (last) MUST appear in the surfaced text per D-10.3-05.
    const allText = JSON.stringify(result)
    expect(allText).toContain('wedding-valet')
    expect(allText).toContain('general-valet')
    expect(allText).toContain('Valid slugs are:')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns upstream_unavailable on Typesense 500', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response('Internal Server Error', { status: 500 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'texas',
        city_slug: 'houston',
        limit: 10,
      },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
    expect(result.structuredContent).toBeUndefined()
  })

  it('returns empty operators array (NOT isError) when Typesense matches 0 rows (D-10.3-07)', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response(JSON.stringify({ hits: [] }), { status: 200 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'wyoming',
        city_slug: 'cheyenne',
        limit: 10,
      },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: unknown[]
      data_freshness: { source: string }
    }
    expect(sc.operators).toEqual([])
    expect(sc.data_freshness.source).toBe('typesense:operators:empty')
  })

  it('passes sort_by=updated_at:desc to Typesense and reorders premium > paid > free client-side (D-10.3-04)', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      capturedUrl = url
      return new Response(
        JSON.stringify({
          hits: [
            {
              document: {
                name: 'Bravo Valet',
                slug: 'bravo-valet',
                primary_city_name: 'Houston',
                primary_state_name: 'Texas',
                primary_city_slug: 'houston',
                primary_state_slug: 'texas',
                services: ['hotel-resort-valet'],
                phone: '555-0002',
                tier: 'free',
                description_text: null,
                typesense_indexed_at: 1700000000,
              },
            },
            {
              document: {
                name: 'Alpha Premium Valet',
                slug: 'alpha-premium-valet',
                primary_city_name: 'Houston',
                primary_state_name: 'Texas',
                primary_city_slug: 'houston',
                primary_state_slug: 'texas',
                services: ['hotel-resort-valet'],
                phone: '555-0001',
                tier: 'premium',
                description_text: null,
                typesense_indexed_at: 1700000001,
              },
            },
            {
              document: {
                name: 'Charlie Paid Valet',
                slug: 'charlie-paid-valet',
                primary_city_name: 'Houston',
                primary_state_name: 'Texas',
                primary_city_slug: 'houston',
                primary_state_slug: 'texas',
                services: ['hotel-resort-valet'],
                phone: '555-0003',
                tier: 'paid',
                description_text: null,
                typesense_indexed_at: 1700000002,
              },
            },
          ],
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const res = (await client.callTool({
      name: 'valet_find_operators_in_city',
      arguments: {
        state_slug: 'texas',
        city_slug: 'houston',
        limit: 10,
      },
    })) as unknown as {
      structuredContent: { operators: { slug: string; tier: string }[] }
    }

    expect(decodeURIComponent(capturedUrl)).toContain('sort_by=updated_at:desc')
    expect(res.structuredContent.operators.map((o) => o.slug)).toEqual([
      'alpha-premium-valet',
      'charlie-paid-valet',
      'bravo-valet',
    ])
  })
})
