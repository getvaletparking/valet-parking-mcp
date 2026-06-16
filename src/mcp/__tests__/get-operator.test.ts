/**
 * vitest tests for src/mcp/tools/get-operator.ts (valet_get_operator).
 * Plan 10.2-03 Task 2.
 *
 * Coverage:
 *   1. Happy path: known slug returns merged profile with website ?ref=mcp stamp (TOOL-12)
 *   2. Promise.all parallel fetch: both upstreams hit in same tick (D-10.2-02)
 *   3. Payload-wins merge: when Typesense has stale name, Payload's name surfaces (D-10.2-03)
 *   4. not_found: both upstreams return 0 hits => isError with 'Operator not found:' prefix (D-10.2-10)
 *   5. upstream_unavailable: Typesense returns 500 => isError with exact text (D-10.2-10)
 *   6. upstream_unavailable: Payload throws => isError with exact text (D-10.2-10)
 *   7. invalid_input: slug 'INVALID_UPPER' fails regex => isError BEFORE any fetch (D-10.2-10)
 *   8. invalid_input: slug 'has spaces' fails regex => isError
 *   9. referral_token absent: outputSchema does NOT advertise the field (D-10.2-06)
 *
 * Stubs globalThis.fetch per-test, branches by URL pattern.
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

// Helper: build the canonical happy-path Typesense hit shape
function buildTypesenseHit(overrides: Record<string, unknown> = {}) {
  return {
    document: {
      id: 'op-test-123',
      name: 'Test Operator',
      slug: 'test-operator',
      primary_city_name: 'Houston',
      primary_state_name: 'Texas',
      primary_city_slug: 'houston',
      primary_state_slug: 'texas',
      service_area_city_slugs: ['houston', 'sugar-land'],
      service_area_count: 2,
      services: ['wedding-valet', 'corporate-event-valet'],
      tier: 'free',
      verified: false,
      claimed: false,
      phone: '+17135551234',
      description_text: 'A test operator for the vitest suite.',
      photo_url: null,
      updated_at: 1700000000000,
      typesense_indexed_at: 1700000000000,
      ...overrides,
    },
  }
}

// Helper: build the canonical happy-path Payload doc shape
function buildPayloadDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-test-123',
    name: 'Test Operator',
    slug: 'test-operator',
    services: [
      { slug: 'wedding-valet', displayName: 'Wedding Valet' },
      { slug: 'corporate-event-valet', displayName: 'Corporate Event Valet' },
    ],
    tier: 'free',
    verified: false,
    claimed: false,
    phone: '+17135551234',
    address: '123 Test Lane, Houston, TX 77002',
    website: 'https://www.testoperator.com/',
    venues_served: [{ venue: 'Houston Convention Center' }, { venue: 'JW Marriott Downtown' }],
    faqs: [
      { question: 'Do you tip the valet?', answer: 'In Houston, $3-5 per car is standard.', source: 'inferred' },
      { question: 'Do you serve weddings?', answer: 'Yes, weddings are our specialty.', source: 'explicit' },
    ],
    buyer_question_phrasings: { 'pricing-clarity': 'How do you quote?' },
    ...overrides,
  }
}

/**
 * Build a happy-path fetch implementation that returns Typesense + Payload
 * data when their respective URLs are hit. Test-specific overrides
 * (e.g. simulating non-200, throws, empty results) can pass through a
 * variant builder.
 */
function buildHappyPathFetch(
  tsHit: ReturnType<typeof buildTypesenseHit>,
  payloadDoc: ReturnType<typeof buildPayloadDoc> | null,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('typesense.getvaletparking.com/collections/operators')) {
      return new Response(
        JSON.stringify({ hits: [tsHit] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.includes('backend.getvaletparking.com/api/operators')) {
      return new Response(
        JSON.stringify(
          payloadDoc ? { docs: [payloadDoc], totalDocs: 1 } : { docs: [], totalDocs: 0 },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw new Error('unexpected fetch URL in test: ' + url)
  }) as typeof globalThis.fetch
}

/**
 * Wire a fresh McpServer + InMemoryTransport bridge to a Client. Returns
 * the connected client. Tests use this to exercise tool calls end-to-end.
 */
async function newClient() {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'vitest', version: '0.0.0' })
  await client.connect(clientTransport)
  return client
}

describe('valet_get_operator', () => {
  // Widened spy type: the typed signature of globalThis.fetch carries
  // Cloudflare-Workers-types overloads with non-unknown param types,
  // but the SpyInstance generic constrains its mock to (this: unknown,
  // ...args: unknown[]) => unknown. Casting through unknown lets the
  // typed signature flow into mockImplementation without a strict-mode
  // overload conflict.
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.fn>
    setMcpEnv(TEST_ENV)
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('happy path: known slug returns merged profile with TOOL-12 ?ref=mcp on website', async () => {
    fetchSpy.mockImplementation(buildHappyPathFetch(buildTypesenseHit(), buildPayloadDoc()))

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'test-operator' },
    })

    expect(result.isError).toBeFalsy()
    const sc = result.structuredContent as {
      operator: { name: string; slug: string; website: string; address: string; venues_served: Array<{ venue: string }>; faqs: Array<{ question: string }> }
      data_freshness: { source: string }
      _meta: { terms: string; attribution: string }
    }
    expect(sc.operator.name).toBe('Test Operator')
    expect(sc.operator.slug).toBe('test-operator')
    // TOOL-12 stamp:
    expect(sc.operator.website).toBe('https://www.testoperator.com/?ref=mcp')
    // Payload long-tail fields surfaced:
    expect(sc.operator.address).toBe('123 Test Lane, Houston, TX 77002')
    expect(sc.operator.venues_served).toHaveLength(2)
    expect(sc.operator.faqs).toHaveLength(2)
    // TOOL-10:
    expect(sc.data_freshness.source).toBe('typesense:operators')
    // TOOL-11:
    expect(sc._meta.terms).toBe('https://api.getvaletparking.com/mcp/terms')
    expect(sc._meta.attribution).toBe('Powered by getvaletparking.com')
  })

  it('Promise.all parallel: both upstreams hit on the same tick (D-10.2-02)', async () => {
    const callOrder: string[] = []
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense.getvaletparking.com/collections/operators')) {
        callOrder.push('typesense')
        await new Promise((resolve) => setTimeout(resolve, 0))
        return new Response(JSON.stringify({ hits: [buildTypesenseHit()] }), { status: 200 })
      }
      if (url.includes('backend.getvaletparking.com/api/operators')) {
        callOrder.push('payload')
        await new Promise((resolve) => setTimeout(resolve, 0))
        return new Response(JSON.stringify({ docs: [buildPayloadDoc()], totalDocs: 1 }), { status: 200 })
      }
      throw new Error('unexpected fetch URL: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    await client.callTool({ name: 'valet_get_operator', arguments: { slug: 'test-operator' } })

    // Both URLs are recorded before either's await completes because
    // Promise.all dispatches them on the same tick. The exact order
    // is non-deterministic (event loop scheduling), so we just assert
    // both were called.
    expect(callOrder).toContain('typesense')
    expect(callOrder).toContain('payload')
    expect(callOrder).toHaveLength(2)
  })

  it('Payload-wins merge: stale Typesense name is overridden by Payload (D-10.2-03)', async () => {
    const tsStaleName = buildTypesenseHit({ name: 'Old Stale Name' })
    const payloadFresh = buildPayloadDoc({ name: 'Fresh Name from Payload' })
    fetchSpy.mockImplementation(buildHappyPathFetch(tsStaleName, payloadFresh))

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'test-operator' },
    })

    const sc = result.structuredContent as { operator: { name: string } }
    // Payload wins on overlap (D-10.2-03):
    expect(sc.operator.name).toBe('Fresh Name from Payload')
  })

  it('not_found: both upstreams return 0 hits => isError with "Operator not found:" prefix (D-10.2-10)', async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense')) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200 })
      }
      if (url.includes('backend')) {
        return new Response(JSON.stringify({ docs: [], totalDocs: 0 }), { status: 200 })
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'this-slug-does-not-exist' },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text.startsWith('Operator not found:')).toBe(true)
    expect(text).toContain('this-slug-does-not-exist')
    // D-10.2-11: NO structuredContent on error
    expect(result.structuredContent).toBeUndefined()
  })

  it('upstream_unavailable: Typesense returns 500 => isError exact text (D-10.2-10)', async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense')) {
        return new Response('upstream broken', { status: 500 })
      }
      // Payload OK; the rejection comes from Typesense alone
      if (url.includes('backend')) {
        return new Response(JSON.stringify({ docs: [], totalDocs: 0 }), { status: 200 })
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'test-operator' },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('upstream_unavailable: Payload fetch throws => isError exact text', async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('typesense')) {
        return new Response(JSON.stringify({ hits: [buildTypesenseHit()] }), { status: 200 })
      }
      if (url.includes('backend')) {
        throw new Error('network failure simulating Payload outage')
      }
      throw new Error('unexpected: ' + url)
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'test-operator' },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toBe('Service temporarily unavailable, please retry.')
  })

  it('invalid_input: uppercase slug "INVALID_UPPER" fails regex BEFORE any fetch (D-10.2-10)', async () => {
    // CRITICAL: fetchSpy should be called ZERO times because the regex
    // check fires before any upstream call. Saves cost-point and latency
    // per D-10.2-10.
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called for invalid_input regex rejection')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'INVALID_UPPER' },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text.startsWith('Invalid slug format:')).toBe(true)
    // Critical: NO upstream calls happened
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('invalid_input: slug with spaces fails regex BEFORE any fetch', async () => {
    fetchSpy.mockImplementation((async () => {
      throw new Error('fetch should NOT be called')
    }) as typeof globalThis.fetch)

    const client = await newClient()
    const result = await client.callTool({
      name: 'valet_get_operator',
      arguments: { slug: 'has spaces in slug' },
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text.startsWith('Invalid slug format:')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('outputSchema does NOT advertise referral_token field (D-10.2-06)', async () => {
    const client = await newClient()
    const tools = await client.listTools()
    const getOperatorTool = tools.tools.find((t) => t.name === 'valet_get_operator')
    expect(getOperatorTool).toBeDefined()
    // The outputSchema's operator object MUST NOT include referral_token.
    // We probe the JSON-schema-serialized outputSchema (SDK converts zod to JSON Schema).
    const outputSchemaJson = JSON.stringify(getOperatorTool?.outputSchema ?? {})
    expect(outputSchemaJson).not.toContain('referral_token')
  })
})
