import { describe, it, expect, beforeAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../server.js'
import { SERVICES_CATALOG_INDEXED_AT } from '../services-catalog.js'

interface ToolListResult {
  tools: Array<{
    name: string
    description?: string
    annotations?: Record<string, unknown>
    inputSchema?: unknown
  }>
}

interface CallToolResult {
  content: Array<{ type: string; text: string }>
  structuredContent: {
    services: Array<{ slug: string; displayName: string; category: string }>
    data_freshness: { indexed_at: string; source: string }
    _meta: { terms: string; attribution: string }
  }
}

describe('valet_list_services', () => {
  let client: Client
  let tools: ToolListResult

  beforeAll(async () => {
    const server = createMcpServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client(
      { name: 'list-services-test', version: '0.0.0' },
      { capabilities: {} },
    )
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
    tools = (await client.listTools()) as unknown as ToolListResult
  })

  it('exposes 7 tools via tools/list (Plan 10.4-02 grew the surface by 2)', () => {
    // Plan 10.1-02 (Wave 0): valet_list_services. Plan 10.2-02 (Wave 1):
    // adds valet_get_operator + valet_search_cities for a 3-tool surface.
    // Plan 10.3-02 (Wave 2): adds valet_find_operators_in_city +
    // valet_search_by_service_and_city for a 5-tool surface. Plan 10.4-02
    // (Wave 4): adds valet_find_nearest_operators + valet_find_operators_near
    // for a 7-tool surface. Wave 10.5 may extend further.
    expect(tools.tools).toHaveLength(7)
  })

  it('names the tool valet_list_services with the 4 mandatory annotations', () => {
    const tool = tools.tools.find((t) => t.name === 'valet_list_services')
    expect(tool).toBeDefined()
    if (!tool) throw new Error('valet_list_services missing from tools/list')
    expect(tool.name).toBe('valet_list_services')
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  it('keeps the tool description under 300 characters and em-dash free', () => {
    const tool = tools.tools.find((t) => t.name === 'valet_list_services')
    if (!tool) throw new Error('valet_list_services missing from tools/list')
    const desc = tool.description ?? ''
    expect(desc.length).toBeLessThanOrEqual(300)
    expect(desc).not.toContain('—')
    // Sanity: leads with verb-object (TOOL-09 first sentence)
    expect(desc.toLowerCase()).toMatch(/^list /)
    // Sanity: contains "Use this when" (TOOL-09 second sentence)
    expect(desc).toContain('Use this when')
  })

  it('returns 9 service entries on tools/call', async () => {
    const result = (await client.callTool({
      name: 'valet_list_services',
      arguments: {},
    })) as unknown as CallToolResult
    expect(result.structuredContent.services).toHaveLength(9)
  })

  it('returns the canonical 9 service slugs in catalog order', async () => {
    const result = (await client.callTool({
      name: 'valet_list_services',
      arguments: {},
    })) as unknown as CallToolResult
    const slugs = result.structuredContent.services.map((s) => s.slug)
    expect(slugs).toEqual([
      'wedding-valet',
      'corporate-event-valet',
      'private-event-valet',
      'funeral-valet',
      'hotel-resort-valet',
      'restaurant-valet',
      'hospital-medical-valet',
      'major-venue-valet',
      'general-valet',
    ])
  })

  it('stamps data_freshness with the catalog indexed_at constant (TOOL-10)', async () => {
    const result = (await client.callTool({
      name: 'valet_list_services',
      arguments: {},
    })) as unknown as CallToolResult
    expect(result.structuredContent.data_freshness).toEqual({
      indexed_at: SERVICES_CATALOG_INDEXED_AT,
      source: 'in-bundle catalog',
    })
  })

  it('attaches _meta with ToS + attribution (TOOL-11)', async () => {
    const result = (await client.callTool({
      name: 'valet_list_services',
      arguments: {},
    })) as unknown as CallToolResult
    expect(result.structuredContent._meta).toEqual({
      terms: 'https://api.getvaletparking.com/mcp/terms',
      attribution: 'Powered by getvaletparking.com',
    })
  })

  it('mirrors structuredContent in content[0].text JSON', async () => {
    const result = (await client.callTool({
      name: 'valet_list_services',
      arguments: {},
    })) as unknown as CallToolResult
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual(result.structuredContent)
  })
})
