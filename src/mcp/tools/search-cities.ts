/**
 * Tool: valet_search_cities
 *
 * Population-ranked autocomplete against the Typesense `cities` collection
 * (D-182 from Phase 02.5). Returns up to `limit` results sorted by
 * _text_match desc then population desc.
 *
 * Per .planning/REQUIREMENTS.md TOOL-02: output tuple is
 * {slug, state_slug, lat, lng, population} per result.
 *
 * Per .planning/phases/10.2-mcp-simple-typesense-tools/10.2-CONTEXT.md
 * §domain: this is one of the 2 Wave 1 tools; mirrors the
 * cities-suggest.ts pattern verbatim (D-182 design).
 *
 * Error model: ONE class (upstream_unavailable). The zod inputSchema's
 * .min(2) on query handles short-input rejection at the SDK validation
 * layer (returns a JSON-RPC -32602 invalid params before the handler
 * runs). No need for a separate invalid_input envelope here.
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { searchCities } from '../cities.js'
import { UPSTREAM_UNAVAILABLE_SENTINEL } from '../operators.js'
import { getMcpEnv } from '../env-context.js'

// Description discipline (TOOL-09):
//   - <=300 characters
//   - first sentence verb-then-object
//   - second sentence "Use this when..."
//   - no em-dashes
//   - no HTML, no JSON examples, no behavior steering
const VALET_SEARCH_CITIES_DESCRIPTION =
  'Search the cities directory by name prefix with population-ranked results. ' +
  'Use this when an agent needs to resolve a partial city name into a canonical ' +
  'city slug plus state slug plus lat/lng before composing valet_find_operators_in_city ' +
  'or valet_find_operators_near. Empty array if no matches.'
// Verified em-dash-free; <=300 chars.

// Output schema, zod authoritative. Full ZodObject (NOT .shape) per V-03.
const outputSchema = z.object({
  cities: z
    .array(
      z.object({
        slug: z.string().describe('Canonical kebab-case city slug (URL-safe)'),
        state_slug: z
          .string()
          .describe('Canonical kebab-case state slug (e.g. texas, new-york)'),
        lat: z
          .number()
          .nullable()
          .describe('City centroid latitude; null if unset in the index'),
        lng: z
          .number()
          .nullable()
          .describe('City centroid longitude; null if unset in the index'),
        population: z
          .number()
          .describe('Census population estimate; used as the sort tiebreaker'),
      }),
    )
    .describe('Cities matching the query, ranked by text match then population desc'),
  data_freshness: z
    .object({
      indexed_at: z.string().describe('Date the cities collection was last fully reindexed'),
      source: z.string().describe('Origin of the data; for this tool: typesense:cities'),
    })
    .describe('TOOL-10 freshness stamp'),
  _meta: z
    .object({
      terms: z.string().url(),
      attribution: z.string(),
    })
    .describe('TOOL-11 ToS and attribution block'),
})

/**
 * Build the upstream_unavailable isError envelope (mirror of the
 * get-operator.ts helper; one error class for this tool).
 */
function upstreamUnavailableError() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Service temporarily unavailable, please retry.',
      },
    ],
    isError: true,
  }
}

/**
 * Build-time indexed_at stamp for the cities collection. Phase 02.5-06
 * reindexed cities from us-cities.csv; subsequent reindexes (rare) bump
 * this constant. Per-row typesense_indexed_at is not in the cities
 * schema (cities are static; no sync hook lag); a flat collection-level
 * stamp is the meaningful freshness signal.
 */
const CITIES_INDEXED_AT = '2026-05-22'

/**
 * Register the valet_search_cities tool against the supplied McpServer.
 */
export function registerSearchCities(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_search_cities',
    {
      title: 'Search Cities',
      description: VALET_SEARCH_CITIES_DESCRIPTION,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        query: z
          .string()
          .min(2)
          .describe(
            "Partial or full city name (>=2 chars). Matched against name and lowercase name fields with prefix semantics.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(8)
          .describe('Max results to return; default 8, capped at 25'),
      },
      outputSchema,
    },
    async (args) => {
      const { query, limit } = args as { query: string; limit: number }

      let results
      try {
        results = await searchCities(query, limit, getMcpEnv())
      } catch (err) {
        if (err instanceof Error && err.message === UPSTREAM_UNAVAILABLE_SENTINEL) {
          return upstreamUnavailableError()
        }
        return upstreamUnavailableError()
      }

      const payload = {
        cities: results,
        data_freshness: {
          indexed_at: CITIES_INDEXED_AT,
          source: 'typesense:cities',
        },
        _meta: {
          terms: 'https://api.getvaletparking.com/mcp/terms',
          attribution: 'Powered by getvaletparking.com',
        },
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}
