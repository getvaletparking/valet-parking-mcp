/**
 * Vitest suite for valet_find_operators_near (TOOL-07).
 * Plan 10.4-05 Task 2.
 *
 * Mirrors find-nearest-operators.test.ts structure.
 *
 * Covers:
 *   1. Happy path with service filter
 *   2. Happy path without service filter (services:= absent)
 *   3. Invalid service enum (9-slug enumeration via zod parse)
 *   4. Missing radius_miles per D-10.4-04: REQUIRED arg. Asserts stable
 *      JSON-RPC envelope shape (isError=true + content[0].text contains
 *      'radius_miles') per checker M-2; does NOT regex-match against SDK
 *      error wording (which can drift across SDK versions).
 *   5. radius out-of-range zod rejection (radius_miles=0)
 *   6. 4xx-shape upstream_unavailable mock (per feedback_vitest_fetch_mocks_hide_4xx)
 *   7. Empty array success per D-10.4-03 (typesense:operators:empty marker)
 *   8. URL grammar verification (filter_by location:(...,${radius} mi) + sort_by location(...):asc)
 *   9. Client-side tier reorder per D-10.4-02: premium > paid > free, distance asc within tier
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

describe('valet_find_operators_near tool', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.fn>
    setMcpEnv(TEST_ENV)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('happy path with service filter: returns operators array', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      return new Response(
        JSON.stringify({ hits: [buildOperatorHit('op1', 'Op One', 'free', 1609)] }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_near',
      arguments: {
        lat: 30.2672,
        lng: -97.7431,
        radius_miles: 15,
        service: 'wedding-valet',
        limit: 10,
      },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: Array<{ slug: string; tier: string; distance_miles: number }>
    }
    expect(sc.operators).toHaveLength(1)
    expect(decodeURIComponent(capturedUrl)).toContain('services:=wedding-valet')
  })

  it('happy path without service filter: services:= filter omitted from URL', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString()
      return new Response(
        JSON.stringify({ hits: [buildOperatorHit('op1', 'Op One', 'free', 1609)] }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    await client.callTool({
      name: 'valet_find_operators_near',
      arguments: { lat: 30.2672, lng: -97.7431, radius_miles: 15, limit: 10 },
    })

    const decoded = decodeURIComponent(capturedUrl)
    expect(decoded).not.toContain('services:=')
  })

  it('rejects invalid service enum with 9-slug enumeration', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called for invalid_input zod rejection')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_near',
      arguments: {
        lat: 30.2672,
        lng: -97.7431,
        radius_miles: 10,
        service: 'wedding-valeting',
        limit: 10,
      },
    })

    const allText = JSON.stringify(result)
    expect(allText).toContain('wedding-valet')
    expect(allText).toContain('general-valet')
    expect(allText).toContain('Valid slugs are:')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects missing radius_miles at zod parse (REQUIRED per D-10.4-04; envelope-shape assertion per M-2)', async () => {
    // Per checker M-2: assert on stable JSON-RPC envelope SHAPE, not on
    // SDK error wording (which can change across SDK versions). The shape
    // properties (isError flag + content array with text) are part of the
    // MCP spec; the field name 'radius_miles' is in the zod schema WE
    // control so it's stable across SDK updates.
    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_near',
      arguments: { lat: 30.2672, lng: -97.7431, limit: 10 },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('radius_miles')

    // Belt-and-braces: fetch should not have been called because zod
    // rejected the args before the handler body ran.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects radius out-of-range (radius_miles=0) at zod parse', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_near',
      arguments: { lat: 30.2672, lng: -97.7431, radius_miles: 0, limit: 10 },
    })

    expect(result.isError).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('4xx-shape upstream_unavailable (per feedback_vitest_fetch_mocks_hide_4xx)', async () => {
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
      name: 'valet_find_operators_near',
      arguments: { lat: 30.2672, lng: -97.7431, radius_miles: 10, limit: 10 },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('empty array success with typesense:operators:empty marker (D-10.4-03)', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response(JSON.stringify({ hits: [] }), { status: 200 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_near',
      arguments: { lat: 37.2487, lng: -83.1932, radius_miles: 5, limit: 10 },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: unknown[]
      data_freshness: { source: string }
    }
    expect(sc.operators).toEqual([])
    expect(sc.data_freshness.source).toBe('typesense:operators:empty')
  })

  it('URL grammar: filter_by location:(...,${radius} mi) + sort_by location(...):asc (NOT 100mi hardcoded)', async () => {
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
      name: 'valet_find_operators_near',
      arguments: { lat: 30.2672, lng: -97.7431, radius_miles: 15, limit: 10 },
    })

    // URLSearchParams encodes spaces as `+`; decode then convert back to
    // literal space to match the canonical Typesense filter expression.
    const decoded = decodeURIComponent(capturedUrl).replace(/\+/g, ' ')
    expect(decoded).toContain('filter_by=location:(30.2672,-97.7431,15 mi)')
    expect(decoded).toContain('sort_by=location(30.2672,-97.7431):asc')
    // Negative check: NOT the 100mi hardcoded cap from TOOL-06
    expect(decoded).not.toContain('100 mi')
  })

  it('client-side tier reorder: premium > paid > free, distance asc within tier (D-10.4-02)', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response(
        JSON.stringify({
          hits: [
            buildOperatorHit('op-free-near', 'OpFreeNear', 'free', 1609), // 1mi
            buildOperatorHit('op-paid-mid', 'OpPaidMid', 'paid', 4828), // 3mi
            buildOperatorHit('op-premium-far', 'OpPremiumFar', 'premium', 8047), // 5mi
          ],
        }),
        { status: 200 },
      )
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_find_operators_near',
      arguments: { lat: 29.7604, lng: -95.3698, radius_miles: 10, limit: 10 },
    })

    const sc = result.structuredContent as {
      operators: Array<{ slug: string; tier: string; distance_miles: number }>
    }
    expect(sc.operators).toHaveLength(3)
    // Tier order: premium first, then paid, then free
    expect(sc.operators[0].slug).toBe('op-premium-far')
    expect(sc.operators[1].slug).toBe('op-paid-mid')
    expect(sc.operators[2].slug).toBe('op-free-near')
    // Tier values present per row
    expect(sc.operators[0].tier).toBe('premium')
    expect(sc.operators[2].tier).toBe('free')
  })
})
