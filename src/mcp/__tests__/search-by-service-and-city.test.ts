/**
 * Vitest suite for valet_search_by_service_and_city (TOOL-05).
 * Plan 10.3-03 Task 2.
 *
 * Mirrors apps/workers/edge-api/src/mcp/__tests__/find-operators-in-city.test.ts.
 *
 * Covers:
 *   1. Happy path
 *   2. Cross-state union URL grammar per D-10.3-03 (no primary_state_slug filter)
 *   3. Invalid service enum (D-10.3-05 9-slug enumeration)
 *   4. Invalid city_slug regex (D-10.3-06)
 *   5. Upstream unavailable on Typesense 500
 *   6. Empty array success per D-10.3-07
 *   7. Sort URL verification per D-10.3-04
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

function buildOperatorHit(overrides: Record<string, unknown> = {}) {
  return {
    document: {
      name: 'Austin Wedding Valet Co',
      slug: 'austin-wedding-valet-co',
      primary_city_name: 'Austin',
      primary_state_name: 'Texas',
      primary_city_slug: 'austin',
      primary_state_slug: 'texas',
      services: ['wedding-valet', 'general-valet'],
      phone: '(555) 555-0200',
      tier: 'premium',
      description_text: 'Austin wedding valet operator.',
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

describe('valet_search_by_service_and_city tool', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.fn>
    setMcpEnv(TEST_ENV)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('happy path: returns operators array on (service, city) lookup', async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense.getvaletparking.com/collections/operators/documents/search')) {
        return new Response(
          JSON.stringify({
            hits: [
              buildOperatorHit(),
              buildOperatorHit({
                slug: 'austin-event-pros',
                name: 'Austin Event Pros',
                tier: 'paid',
              }),
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'wedding-valet',
        city_slug: 'austin',
        limit: 10,
      },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operators: Array<{ name: string; slug: string; tier: string }>
      data_freshness: { source: string }
      _meta: { terms: string; attribution: string }
    }
    expect(sc.operators).toHaveLength(2)
    expect(sc.data_freshness.source).toBe('typesense:operators')
    expect(sc._meta.attribution).toBe('Powered by getvaletparking.com')
  })

  it('builds cross-state union URL: no primary_state_slug filter (D-10.3-03)', async () => {
    let capturedUrl = ''
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      capturedUrl = url
      if (url.includes('typesense.getvaletparking.com/collections/operators/documents/search')) {
        return new Response(
          JSON.stringify({
            hits: [
              buildOperatorHit({
                slug: 'springfield-mo-op',
                primary_city_name: 'Springfield',
                primary_state_name: 'Missouri',
                primary_city_slug: 'springfield',
                primary_state_slug: 'missouri',
              }),
              buildOperatorHit({
                slug: 'springfield-il-op',
                primary_city_name: 'Springfield',
                primary_state_name: 'Illinois',
                primary_city_slug: 'springfield',
                primary_state_slug: 'illinois',
              }),
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    await client.callTool({
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'wedding-valet',
        city_slug: 'springfield',
        limit: 10,
      },
    })

    const decoded = decodeURIComponent(capturedUrl)
    expect(decoded).toContain('services:=wedding-valet')
    expect(decoded).toContain('service_area_city_slugs:=springfield')
    // D-10.3-03: NO primary_state_slug filter on URL
    expect(decoded).not.toContain('primary_state_slug:=')
  })

  it('rejects invalid service_slug with 9-slug enumeration (D-10.3-05)', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called for invalid_input zod rejection')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'wedding-valeting',
        city_slug: 'austin',
        limit: 10,
      },
    })

    const allText = JSON.stringify(result)
    expect(allText).toContain('Valid slugs are:')
    expect(allText).toContain('wedding-valet')
    expect(allText).toContain('general-valet')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid city_slug (spaces) BEFORE upstream fetch (D-10.3-06)', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'wedding-valet',
        city_slug: 'New Austin',
        limit: 10,
      },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text.startsWith('Invalid city_slug:')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns upstream_unavailable on Typesense 500', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response('Internal Server Error', { status: 500 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'wedding-valet',
        city_slug: 'austin',
        limit: 10,
      },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('returns empty operators array (NOT isError) when 0 rows match (D-10.3-07)', async () => {
    fetchSpy.mockImplementation((async () => {
      return new Response(JSON.stringify({ hits: [] }), { status: 200 })
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'funeral-valet',
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
                name: 'Zebra Free Valet',
                slug: 'zebra-free-valet',
                primary_city_name: 'Austin',
                primary_state_name: 'Texas',
                primary_city_slug: 'austin',
                primary_state_slug: 'texas',
                services: ['wedding-valet'],
                phone: '555-9999',
                tier: 'free',
                description_text: null,
                typesense_indexed_at: 1700000000,
              },
            },
            {
              document: {
                name: 'Apex Premium Valet',
                slug: 'apex-premium-valet',
                primary_city_name: 'Austin',
                primary_state_name: 'Texas',
                primary_city_slug: 'austin',
                primary_state_slug: 'texas',
                services: ['wedding-valet'],
                phone: '555-0001',
                tier: 'premium',
                description_text: null,
                typesense_indexed_at: 1700000001,
              },
            },
            {
              document: {
                name: 'Beta Paid Valet',
                slug: 'beta-paid-valet',
                primary_city_name: 'Austin',
                primary_state_name: 'Texas',
                primary_city_slug: 'austin',
                primary_state_slug: 'texas',
                services: ['wedding-valet'],
                phone: '555-0002',
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
      name: 'valet_search_by_service_and_city',
      arguments: {
        service_slug: 'wedding-valet',
        city_slug: 'austin',
        limit: 10,
      },
    })) as unknown as {
      structuredContent: { operators: { slug: string; tier: string }[] }
    }

    expect(decodeURIComponent(capturedUrl)).toContain('sort_by=updated_at:desc')
    expect(res.structuredContent.operators.map((o) => o.slug)).toEqual([
      'apex-premium-valet',
      'beta-paid-valet',
      'zebra-free-valet',
    ])
  })
})
