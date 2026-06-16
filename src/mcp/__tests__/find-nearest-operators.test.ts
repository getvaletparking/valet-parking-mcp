/**
 * Vitest suite for valet_find_nearest_operators (TOOL-06).
 * Plan 10.4-05 Task 1.
 *
 * Mirrors apps/workers/edge-api/src/mcp/__tests__/find-operators-in-city.test.ts
 * structure. Tests handler-level invariants by invoking the registered
 * tool against a stubbed globalThis.fetch (per the 10.2 D-10.2 vitest
 * fetch-stub recommendation).
 *
 * Covers:
 *   1. Happy path with service filter (D-10.4-02 URL grammar; distance_miles attached)
 *   2. Happy path without service filter (services:= absent)
 *   3. Invalid service enum (D-10.4 9-slug enumeration via zod parse)
 *   4. lat out-of-range zod rejection (lat=91)
 *   5. lng out-of-range zod rejection (lng=181)
 *   6. Upstream unavailable via 4xx-shape mock per feedback_vitest_fetch_mocks_hide_4xx
 *   7. Empty array success per D-10.4-03 (typesense:operators:empty marker)
 *   8. URL grammar verification: filter_by location:(...,100 mi) + sort_by location(...):asc
 *   9. distance_miles per row: 8047 meters -> 5.0 miles
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
 * Build a Typesense operators hit shape. Matches mapOperatorSummary input
 * contract + the envelope-level geo_distance_meters.location used by the
 * geo helpers (operators.ts findNearestOperators).
 */
function buildOperatorHit(
  slug: string,
  name: string,
  tier: string,
  distanceMeters: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    document: {
      name,
      slug,
      primary_city_name: 'Houston',
      primary_state_name: 'Texas',
      primary_city_slug: 'houston',
      primary_state_slug: 'texas',
      services: ['hotel-resort-valet', 'general-valet'],
      phone: '(555) 555-0100',
      tier,
      description_text: 'Test description.',
      typesense_indexed_at: 1717000000000,
      updated_at: 1716000000000,
      ...overrides,
    },
    geo_distance_meters: { location: distanceMeters },
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

describe('valet_find_nearest_operators tool', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.fn>
    setMcpEnv(TEST_ENV)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('happy path with service filter: returns operators with distance_miles attached', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      capturedUrl = url
      if (url.includes('typesense.getvaletparking.com/collections/operators/documents/search')) {
        return new Response(
          JSON.stringify({
            hits: [
              buildOperatorHit('op-near', 'Op Near', 'free', 1609),
              buildOperatorHit('op-far', 'Op Far', 'free', 16093),
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('unexpected fetch URL: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 29.7604, lng: -95.3698, service: 'hotel-resort-valet', limit: 5 },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: Array<{ name: string; slug: string; tier: string; distance_miles: number }>
      data_freshness: { indexed_at: string; source: string }
      _meta: { terms: string; attribution: string }
    }
    expect(sc.operators).toHaveLength(2)
    expect(sc.operators[0].distance_miles).toBe(1.0)
    expect(sc.operators[1].distance_miles).toBe(10.0)
    expect(sc.data_freshness.source).toBe('typesense:operators')
    expect(sc._meta.terms).toBe('https://api.getvaletparking.com/mcp/terms')

    // D-10.4-02 URL grammar: services:= filter present, 100mi cap
    expect(decodeURIComponent(capturedUrl)).toContain('services:=hotel-resort-valet')
  })

  it('happy path without service filter: URL omits services:= clause', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      capturedUrl = url
      return new Response(
        JSON.stringify({ hits: [buildOperatorHit('op1', 'Op One', 'free', 3220)] }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 29.7604, lng: -95.3698, limit: 5 },
    })

    expect(result.isError).toBeFalsy()
    // URLSearchParams encodes spaces as `+` in query strings; decodeURIComponent
    // does NOT decode `+`. Replace `+` with space to assert the canonical filter
    // expression (the Typesense URL grammar uses literal spaces).
    const decoded = decodeURIComponent(capturedUrl).replace(/\+/g, ' ')
    expect(decoded).toContain('location:(29.7604,-95.3698,100 mi)')
    expect(decoded).not.toContain('services:=')
  })

  it('rejects invalid service enum with 9-slug enumeration', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called for invalid_input zod rejection')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: {
        lat: 29.7604,
        lng: -95.3698,
        service: 'wedding-valeting',
        limit: 5,
      },
    })

    // The SDK validator surfaces zod enum errors via an isError envelope.
    // Both wedding-valet (first) and general-valet (last) MUST appear in
    // the surfaced text per the canonical 9-slug enumeration; the canonical
    // "Valid slugs are:" prefix is hand-written in find-nearest-operators.ts.
    const allText = JSON.stringify(result)
    expect(allText).toContain('wedding-valet')
    expect(allText).toContain('general-valet')
    expect(allText).toContain('Valid slugs are:')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects lat out-of-range (lat=91) at zod parse; fetch not called', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 91, lng: -95.3698, limit: 5 },
    })

    expect(result.isError).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects lng out-of-range (lng=181) at zod parse; fetch not called', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 29.7604, lng: 181, limit: 5 },
    })

    expect(result.isError).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('4xx-shape upstream_unavailable (per feedback_vitest_fetch_mocks_hide_4xx)', async () => {
    // Per feedback_vitest_fetch_mocks_hide_4xx: pair URL-shape mocks with
    // a 4xx-shape mock asserting UPSTREAM_UNAVAILABLE_SENTINEL re-throw.
    // Body shape matches a real Typesense schema rejection (the 10.3-03
    // hotfix surface).
    fetchSpy.mockImplementation((async () => {
      return new Response(
        JSON.stringify({
          message: "Could not parse 'sort_by'. Field 'location' does not support distance sorting.",
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 29.7604, lng: -95.3698, limit: 5 },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('empty array success (NOT isError) with typesense:operators:empty marker (D-10.4-03)', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response(JSON.stringify({ hits: [] }), { status: 200 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 37.2487, lng: -83.1932, limit: 10 },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: unknown[]
      data_freshness: { source: string }
    }
    expect(sc.operators).toEqual([])
    expect(sc.data_freshness.source).toBe('typesense:operators:empty')
  })

  it('URL grammar: filter_by location:(...,100 mi) + sort_by location(...):asc (D-10.4-03)', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      return new Response(
        JSON.stringify({ hits: [buildOperatorHit('op1', 'Op1', 'free', 1609)] }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 29.7604, lng: -95.3698, limit: 5 },
    })

    // URLSearchParams encodes spaces as `+`; decode then convert back to
    // literal space to match the canonical Typesense filter expression.
    const decoded = decodeURIComponent(capturedUrl).replace(/\+/g, ' ')
    expect(decoded).toContain('filter_by=location:(29.7604,-95.3698,100 mi)')
    expect(decoded).toContain('sort_by=location(29.7604,-95.3698):asc')
  })

  it('distance_miles per row: 8047 meters -> 5.0 miles', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response(
        JSON.stringify({ hits: [buildOperatorHit('op1', 'Op1', 'free', 8047)] }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_nearest_operators',
      arguments: { lat: 29.7604, lng: -95.3698, limit: 5 },
    })

    const sc = result.structuredContent as { operators: Array<{ distance_miles: number }> }
    expect(sc.operators[0].distance_miles).toBe(5.0)
  })
})
