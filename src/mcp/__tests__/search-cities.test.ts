/**
 * vitest tests for src/mcp/tools/search-cities.ts (valet_search_cities).
 * Plan 10.2-03 Task 3.
 *
 * Coverage:
 *   1. Happy path: q=hou limit=5 returns 5 cities with Houston #1 (D-182 ranking)
 *   2. Empty results: q=zzzz returns empty cities array (200 + valid envelope)
 *   3. upstream_unavailable: Typesense returns 500 => isError with exact text
 *   4. upstream_unavailable: Typesense fetch throws => isError with exact text
 *   5. zod inputSchema rejects query.length<2: tools/call with query="h" errors at SDK validation layer
 *   6. data_freshness + _meta stamps correct (TOOL-10 + TOOL-11)
 *
 * Stubs globalThis.fetch per-test, branches by Typesense URL pattern.
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
 * Build a Typesense city hit shape. Matches typesense-schema.cities.json.
 */
function buildCityHit(slug: string, state_slug: string, population: number, centroid: [number, number]) {
  return {
    document: {
      slug,
      state_slug,
      population,
      centroid,
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

describe('valet_search_cities', () => {
  // Widened spy type: see get-operator.test.ts for the same pattern.
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.fn>
    setMcpEnv(TEST_ENV)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('happy path: q=hou limit=5 returns 5 cities with Houston #1 (D-182 ranking)', async () => {
    // The Typesense sort_by clause is _text_match:desc,population:desc.
    // All 5 cities prefix-match 'hou', so _text_match is equivalent;
    // population breaks the tie. Houston (pop 2.3M) > Houma (pop 33k) >
    // others. We mock the Typesense response to reflect this canonical order.
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense.getvaletparking.com/collections/cities/documents/search')) {
        // Verify the URL params include the locked sort_by clause
        // and per_page matches limit
        expect(url).toContain('sort_by=_text_match%3Adesc%2Cpopulation%3Adesc')
        expect(url).toContain('per_page=5')
        expect(url).toContain('q=hou')
        return new Response(
          JSON.stringify({
            hits: [
              buildCityHit('houston', 'texas', 2304580, [29.7604, -95.3698]),
              buildCityHit('houma', 'louisiana', 33406, [29.5958, -90.7195]),
              buildCityHit('mountain-house', 'california', 23859, [37.7762, -121.5419]),
              buildCityHit('south-houston', 'texas', 16983, [29.6627, -95.2371]),
              buildCityHit('houghton', 'michigan', 8259, [47.1216, -88.5694]),
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('unexpected fetch URL: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_cities',
      arguments: { query: 'hou', limit: 5 },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      cities: Array<{ slug: string; state_slug: string; population: number }>
      data_freshness: { source: string }
      _meta: { terms: string; attribution: string }
    }
    expect(sc.cities).toHaveLength(5)
    // CRITICAL D-182 + roadmap success criterion #2:
    expect(sc.cities[0].slug).toBe('houston')
    expect(sc.cities[0].state_slug).toBe('texas')
    expect(sc.cities[0].population).toBe(2304580)
    // TOOL-10:
    expect(sc.data_freshness.source).toBe('typesense:cities')
    // TOOL-11:
    expect(sc._meta.terms).toBe('https://api.getvaletparking.com/mcp/terms')
    expect(sc._meta.attribution).toBe('Powered by getvaletparking.com')
  })

  it('empty results: q=zzzz returns empty cities array (graceful no-results)', async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense.getvaletparking.com/collections/cities/documents/search')) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200 })
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_cities',
      arguments: { query: 'zzzz', limit: 5 },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as { cities: unknown[] }
    expect(sc.cities).toEqual([])
  })

  it('upstream_unavailable: Typesense returns 500 => isError with exact text', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response('upstream broken', { status: 500 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_cities',
      arguments: { query: 'hou', limit: 5 },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('upstream_unavailable: Typesense fetch throws => isError with exact text', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('network failure simulating Typesense outage')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_cities',
      arguments: { query: 'hou', limit: 5 },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('zod inputSchema rejects query.length<2 at SDK validation layer', async () => {
    // The zod inputSchema has query.min(2). The SDK validates BEFORE the
    // handler runs; a query of length 1 surfaces as an isError envelope
    // with MCP error -32602 (Input validation error). The SDK does NOT
    // throw; it returns the envelope so agents can recover gracefully.
    // The substantive assertion is that the validation fired BEFORE the
    // handler (no upstream fetch), not the exact rejection mechanism.
    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_cities',
      arguments: { query: 'h', limit: 5 },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toMatch(/validation|Invalid arguments|too_small|2 character/i)
    // No fetch should have been called (validation fired before handler)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('respects default limit=8 when omitted', async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      // Verify the default 8 was injected
      expect(url).toContain('per_page=8')
      return new Response(JSON.stringify({ hits: [] }), { status: 200 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    await client.callTool({
      name: 'valet_search_cities',
      arguments: { query: 'hou' },  // limit omitted; default 8 should apply
    })

    expect(fetchSpy).toHaveBeenCalled()
  })
})
