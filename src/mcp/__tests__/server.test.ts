/**
 * vitest tests for src/mcp/server.ts createMcpServer() factory.
 * Plan 10.2-03 Task 3.5 (M-4 closure, revision iteration 2).
 * Plan 10.3-03 Task 3: tool surface grew 3 -> 5 (TOOL-04 + TOOL-05).
 * Plan 10.4-02 Task 3: tool surface grew 5 -> 7 (TOOL-06 + TOOL-07).
 *
 * Coverage:
 *   1. createMcpServer() exposes exactly 7 tools (valet_list_services,
 *      valet_get_operator, valet_search_cities, valet_find_operators_in_city,
 *      valet_search_by_service_and_city, valet_find_nearest_operators,
 *      valet_find_operators_near) on a single McpServer instance.
 *   2. Tool names are stable: all 7 expected names appear in listTools()
 *      output (catches typos, missing register* calls, accidental tool
 *      renames between waves).
 *   3. Factory is stateless: two independent createMcpServer() calls
 *      produce two independent instances; tool registration is consistent
 *      across them (catches module-scope leakage from 10.1-02 D-10.1-04).
 *
 * Why this exists: M-4 from the revision-2 checker noted that without
 * this assertion, a registration regression in src/mcp/server.ts (e.g.,
 * a future Wave 10.5 task forgetting to add a new register* call to
 * createMcpServer) would only surface in the production deploy curls.
 * Pre-deploy CI must catch it instead.
 */
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../server.js'

async function newClient() {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'server-test', version: '0.0.0' },
    { capabilities: {} },
  )
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

describe('createMcpServer() all 7 Wave 1+2+3+4 tools registered (M-4 closure)', () => {
  it('exposes exactly 7 tools on a single McpServer instance', async () => {
    const client = await newClient()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(7)
  })

  it('includes all 7 expected tool names (catches register* regression)', async () => {
    const client = await newClient()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    // Expected order after sort: find_nearest, find_near, find_in_city,
    // get, list, search_by, search_cities.
    expect(names).toEqual([
      'valet_find_nearest_operators',
      'valet_find_operators_in_city',
      'valet_find_operators_near',
      'valet_get_operator',
      'valet_list_services',
      'valet_search_by_service_and_city',
      'valet_search_cities',
    ])
  })

  it('individually verifies both new Wave 2 tools (TOOL-04 + TOOL-05) registered', async () => {
    const client = await newClient()
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'valet_find_operators_in_city')).toBeDefined()
    expect(tools.find((t) => t.name === 'valet_search_by_service_and_city')).toBeDefined()
  })

  it('individually verifies both new Plan 10.4-02 tools (TOOL-06 + TOOL-07) registered', async () => {
    const client = await newClient()
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'valet_find_nearest_operators')).toBeDefined()
    expect(tools.find((t) => t.name === 'valet_find_operators_near')).toBeDefined()
  })

  it('produces independent instances with consistent tool surface', async () => {
    // Stateless factory check: each createMcpServer() call yields a
    // fresh McpServer with the same registered tool surface. Catches
    // module-scope leakage (e.g., a regression that registers tools on
    // a shared singleton instead of per-instance).
    const c1 = await newClient()
    const c2 = await newClient()
    const list1 = await c1.listTools()
    const list2 = await c2.listTools()
    const names1 = list1.tools.map((t) => t.name).sort()
    const names2 = list2.tools.map((t) => t.name).sort()
    expect(names1).toEqual(names2)
    expect(names1).toHaveLength(7)
  })
})
