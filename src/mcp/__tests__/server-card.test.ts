/**
 * Phase 10.6-02 vitest drift defense per D-10.6-10.
 *
 * Asserts 8 invariants on the SERVER_CARD constant:
 *   1. tools[] names match the 7-tool set exactly (set equality + length)
 *   2. tools[].description matches each __snapshots__/{tool}.json verbatim
 *   3. SERVER_CARD.description is em-dash-free
 *   4. tools[].description fields are all em-dash-free
 *   5. SERVER_CARD.version === "0.1.0" (matches v0.1.0 tag)
 *   6. SERVER_CARD.transport === "streamable-http"
 *   7. SERVER_CARD.endpoint === "https://api.getvaletparking.com/mcp"
 *   8. SERVER_CARD.license === "MIT"
 *
 * Path resolution uses fileURLToPath(import.meta.url) so the test is
 * cwd-independent (RESEARCH.md Pattern 9 precedent).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_CARD } from '../server-card.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SNAPSHOTS_DIR = join(__dirname, '..', '__snapshots__')

const EXPECTED_TOOL_NAMES = [
  'valet_list_services',
  'valet_get_operator',
  'valet_search_cities',
  'valet_find_operators_in_city',
  'valet_search_by_service_and_city',
  'valet_find_nearest_operators',
  'valet_find_operators_near',
]

describe('server-card drift defense (D-10.6-10)', () => {
  it('tools[] names match the 7-tool set exactly', () => {
    const names = SERVER_CARD.tools.map((t) => t.name)
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOL_NAMES))
    expect(names.length).toBe(7)
  })

  it('tools[].description matches snapshot files verbatim', () => {
    for (const tool of SERVER_CARD.tools) {
      const snap = JSON.parse(
        readFileSync(join(SNAPSHOTS_DIR, `${tool.name}.json`), 'utf-8'),
      ) as { description: string }
      expect(tool.description, `${tool.name} description must match snapshot`).toBe(
        snap.description,
      )
    }
  })

  it('SERVER_CARD.description is em-dash-free', () => {
    expect(SERVER_CARD.description, 'em-dash forbidden in description').not.toMatch(/—/)
  })

  it('tools[].description fields are em-dash-free', () => {
    for (const tool of SERVER_CARD.tools) {
      expect(tool.description, `${tool.name} description must be em-dash-free`).not.toMatch(/—/)
    }
  })

  it('SERVER_CARD.version === "0.1.0" (matches v0.1.0 tag)', () => {
    expect(SERVER_CARD.version).toBe('0.1.0')
  })

  it('SERVER_CARD.transport === "streamable-http"', () => {
    expect(SERVER_CARD.transport).toBe('streamable-http')
  })

  it('SERVER_CARD.endpoint === "https://api.getvaletparking.com/mcp"', () => {
    expect(SERVER_CARD.endpoint).toBe('https://api.getvaletparking.com/mcp')
  })

  it('SERVER_CARD.license === "MIT"', () => {
    expect(SERVER_CARD.license).toBe('MIT')
  })
})
