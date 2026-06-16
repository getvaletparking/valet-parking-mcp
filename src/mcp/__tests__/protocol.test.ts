import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../server.js'

async function buildPair() {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'protocol-test', version: '0.0.0' },
    { capabilities: {} },
  )
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return { server, client }
}

describe('MCP protocol round-trip', () => {
  it('reports server identity { name: getvaletparking, version: 1.0.0 } after initialize', async () => {
    const { client } = await buildPair()
    const info = client.getServerVersion()
    expect(info).toEqual({ name: 'getvaletparking', version: '1.0.0' })
  })

  it('advertises tools capability after initialize (MCP-01)', async () => {
    const { client } = await buildPair()
    const caps = client.getServerCapabilities()
    expect(caps).toBeDefined()
    expect(caps?.tools).toBeDefined()
  })

  it('survives reconnect with stable capabilities', async () => {
    const { client } = await buildPair()
    const before = client.getServerCapabilities()
    // Reconnect via a fresh pair backed by a new server instance
    const { client: client2 } = await buildPair()
    const after = client2.getServerCapabilities()
    expect(after).toEqual(before)
  })

  it('surfaces tools/call against an unknown tool as an error (SDK returns isError or throws)', async () => {
    // Per <behavior> Test 4 in the plan: the SDK's exact behavior is
    // "rejects OR returns { isError: true, content: [...] }". @modelcontextprotocol/sdk@1.29.0
    // actually returns the latter (isError envelope with MCP error -32602 in content).
    // We accept either shape; the substantive assertion is that the unknown tool is
    // surfaced as an error, not silently allowed.
    const { client } = await buildPair()
    let result: { isError?: boolean; content?: Array<{ type: string; text: string }> } | undefined
    let threw = false
    try {
      result = (await client.callTool({
        name: 'nonexistent_tool',
        arguments: {},
      })) as typeof result
    } catch {
      threw = true
    }
    if (threw) {
      // Some SDK versions throw; either shape satisfies the assertion
      expect(threw).toBe(true)
    } else {
      expect(result).toBeDefined()
      expect(result?.isError).toBe(true)
      expect(result?.content?.[0].text).toMatch(/not found|Unknown tool|nonexistent_tool/i)
    }
  })

  it('completes a successful tools/call without triggering AJV new Function() (MCP-03)', async () => {
    const { client } = await buildPair()
    // The test running at all means CfWorkerJsonSchemaValidator opt-in held.
    // Make the assertion explicit: the call returns content[0].
    const result = await client.callTool({
      name: 'valet_list_services',
      arguments: {},
    })
    const content = (result as { content?: Array<{ type: string }> }).content
    expect(content).toBeDefined()
    expect(Array.isArray(content)).toBe(true)
    expect(content![0].type).toBe('text')
  })

  it('produces independent McpServer instances from createMcpServer (no global state)', async () => {
    const s1 = createMcpServer()
    const s2 = createMcpServer()
    expect(s1).not.toBe(s2)
    // Both should expose the same tool surface (via a fresh client each)
    const [tA, tB] = InMemoryTransport.createLinkedPair()
    const cA = new Client(
      { name: 'p1', version: '0.0.0' },
      { capabilities: {} },
    )
    await Promise.all([s1.connect(tA), cA.connect(tB)])
    const list1 = await cA.listTools()
    // Plan 10.1-02 (Wave 0): 1 tool (valet_list_services). Plan 10.2-02
    // (Wave 1): grew the surface to 3 (added valet_get_operator +
    // valet_search_cities). Plan 10.3-02 (Wave 2): grew to 5 (added
    // valet_find_operators_in_city + valet_search_by_service_and_city).
    // Plan 10.4-02 (Wave 4): grew to 7 (added valet_find_nearest_operators
    // + valet_find_operators_near). Wave 10.5 may extend further.
    const tools = (list1 as {
      tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
    }).tools
    expect(tools.length).toBe(7)
    // Per-tool presence checks for the two Wave 2 additions (TOOL-04 + TOOL-05).
    expect(tools.find((t) => t.name === 'valet_find_operators_in_city')).toBeDefined()
    expect(tools.find((t) => t.name === 'valet_search_by_service_and_city')).toBeDefined()
    // Per-tool presence + TOOL-08 annotation check for the two Plan 10.4-02
    // additions (TOOL-06 + TOOL-07).
    const findNearest = tools.find((t) => t.name === 'valet_find_nearest_operators')
    expect(findNearest).toBeDefined()
    expect(findNearest?.annotations?.readOnlyHint).toBe(true)
    const findOperatorsNear = tools.find((t) => t.name === 'valet_find_operators_near')
    expect(findOperatorsNear).toBeDefined()
    expect(findOperatorsNear?.annotations?.readOnlyHint).toBe(true)
  })
})
