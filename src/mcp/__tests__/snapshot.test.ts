/**
 * Phase 10.5 QUAL-13: per-tool schema snapshot diff.
 *
 * Uses the InMemoryTransport + Client.listTools pattern proven at
 * protocol.test.ts:6-18 (since the SDK's _registeredTools is private; the
 * public introspection point is the listTools() round-trip). Each tool's
 * wire-format definition is serialized and diffed against a committed
 * snapshot file via vitest toMatchFileSnapshot.
 *
 * Per D-10.5-13 update workflow:
 *   pnpm test:update-snapshots
 * regenerates all 7 files. Commit the updated files with a `schema-snapshot:`
 * prefix per D-10.5-14; the prefix is the rubber-stamp for the human
 * reviewer to recognize an intentional contract change.
 *
 * Per the Anti-pattern 3 note in RESEARCH.md: one snapshot.test.ts file
 * iterating all 7 tools is the consolidate-don't-fragment posture; do NOT
 * create per-tool snapshot test files.
 */
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../server.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SNAPSHOT_DIR = path.join(__dirname, '..', '__snapshots__')

const EXPECTED_TOOL_NAMES = [
  'valet_list_services',
  'valet_get_operator',
  'valet_search_cities',
  'valet_find_operators_in_city',
  'valet_search_by_service_and_city',
  'valet_find_nearest_operators',
  'valet_find_operators_near',
] as const

interface ToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: unknown
}

async function fetchToolsViaClient(): Promise<ToolDefinition[]> {
  const server = createMcpServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'snapshot-vitest', version: '0.0.0' })
  await client.connect(clientTransport)
  const result = await client.listTools()
  return result.tools as ToolDefinition[]
}

describe('MCP tool schema snapshots (QUAL-13)', () => {
  for (const expectedName of EXPECTED_TOOL_NAMES) {
    it(`${expectedName} matches committed snapshot`, async () => {
      const tools = await fetchToolsViaClient()
      const found = tools.find((t) => t.name === expectedName)
      expect(found, `${expectedName} present in tools/list`).toBeDefined()
      const serialized = JSON.stringify(found, null, 2)
      const snapshotPath = path.join(SNAPSHOT_DIR, `${expectedName}.json`)
      await expect(serialized).toMatchFileSnapshot(snapshotPath)
    })
  }
})
