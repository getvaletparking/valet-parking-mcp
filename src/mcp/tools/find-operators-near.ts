/**
 * Tool: valet_find_operators_near
 *
 * Tier-then-distance-ranked operator lookup within an agent-specified
 * radius. Per Phase 10.4-CONTEXT:
 *   - D-10.4-02: client-side reorder via sortOperatorsByTierThenDistance
 *               in the helper (premium first within tier, then distance asc)
 *   - D-10.4-04: radius_miles is REQUIRED, no default; agent picks based
 *               on context (5mi event venue, 50mi regional sweep)
 *   - D-10.4-13: empty array success uses data_freshness.source = 'typesense:operators:empty'
 *
 * Error model: 1 class (upstream_unavailable via UPSTREAM_UNAVAILABLE_SENTINEL catch).
 * zod validates lat/lng/radius/service/limit at parse time; invalid args
 * surface as SDK -32602 envelope (matches 10.3 service_slug pattern).
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  findOperatorsNear,
  UPSTREAM_UNAVAILABLE_SENTINEL,
} from '../operators.js'
import { getMcpEnv } from '../env-context.js'
import { SERVICES_CATALOG } from '../services-catalog.js'

// TOOL-09 description: <=300 chars, verb-object first, "Use this when..." second, no em-dashes.
const VALET_FIND_OPERATORS_NEAR_DESCRIPTION =
  'Find valet operators within a given radius of a coordinate, ranked premium tier first then distance. ' +
  'Use this when you have a coordinate and an event-context radius (5mi single venue, 25mi metro, 50mi regional). ' +
  'radius_miles is required; empty array if no matches.'
// Verified em-dash-free; <=300 chars.

const SERVICE_SLUGS = SERVICES_CATALOG.map((s) => s.slug) as [string, ...string[]]

const INVALID_SERVICE_MESSAGE =
  "Invalid service: Valid slugs are: wedding-valet, corporate-event-valet, " +
  "private-event-valet, funeral-valet, hotel-resort-valet, restaurant-valet, " +
  "hospital-medical-valet, major-venue-valet, general-valet."

const outputSchema = z.object({
  operators: z
    .array(
      z.object({
        name: z.string().describe('Operator business name'),
        slug: z.string().describe('Canonical kebab-case operator slug; pass to valet_get_operator for details'),
        primary_city_name: z.string().describe('Display name of operator HQ city'),
        primary_state_name: z.string().describe('Display name of operator HQ state'),
        primary_city_slug: z.string().describe('Canonical kebab-case HQ city slug'),
        primary_state_slug: z.string().describe('Canonical kebab-case HQ state slug'),
        services: z.array(z.string()).describe('Canonical service slugs this operator offers'),
        phone: z.string().nullable().describe('Operator phone number, null if not on file'),
        tier: z.string().describe("Operator tier: 'free', 'paid', or 'premium'"),
        description_text: z.string().nullable().describe('Plain-text summary; null if not on file'),
        distance_miles: z.number().describe('Distance from the input coordinate to operator HQ, rounded to 1 decimal'),
      }),
    )
    .describe('Operators within radius_miles of the input coordinate, ranked tier:desc then distance:asc. Empty array means no matches within radius.'),
  data_freshness: z
    .object({
      indexed_at: z.string().describe('ISO timestamp of the freshest row in the batch'),
      source: z.string().describe('Origin tag: typesense:operators or typesense:operators:empty'),
    })
    .describe('TOOL-10 freshness stamp'),
  _meta: z
    .object({
      terms: z.string().url(),
      attribution: z.string(),
    })
    .describe('TOOL-11 ToS and attribution block'),
})

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

export function registerFindOperatorsNear(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_find_operators_near',
    {
      title: 'Find Operators Near',
      description: VALET_FIND_OPERATORS_NEAR_DESCRIPTION,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        lat: z
          .number()
          .min(-90)
          .max(90)
          .describe('Latitude in decimal degrees (WGS84). Range: -90 to 90.'),
        lng: z
          .number()
          .min(-180)
          .max(180)
          .describe('Longitude in decimal degrees (WGS84). Range: -180 to 180.'),
        radius_miles: z
          .number()
          .min(0.1)
          .max(500)
          .describe(
            'Search radius in miles. REQUIRED, no default. Pick based on context: 5 mi for a single venue, 25 mi for a metro, 50 mi for a regional sweep.',
          ),
        service: z
          .enum(SERVICE_SLUGS, { errorMap: () => ({ message: INVALID_SERVICE_MESSAGE }) })
          .optional()
          .describe(
            'Optional service narrowing. One of the 9 canonical valet service slugs. ' +
              'Omit to list every operator within radius regardless of services offered.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Max results to return; default 10, capped at 50'),
      },
      outputSchema,
    },
    async (args) => {
      const { lat, lng, radius_miles, service, limit } = args as {
        lat: number
        lng: number
        radius_miles: number
        service: string | undefined
        limit: number
      }

      let results
      try {
        results = await findOperatorsNear(lat, lng, radius_miles, service, limit, getMcpEnv())
      } catch (err) {
        if (err instanceof Error && err.message === UPSTREAM_UNAVAILABLE_SENTINEL) {
          return upstreamUnavailableError()
        }
        return upstreamUnavailableError()
      }

      const indexedAt =
        results.length > 0
          ? new Date(
              Math.max(...results.map((r) => r.typesense_indexed_at)),
            ).toISOString()
          : new Date().toISOString()
      const source = results.length > 0 ? 'typesense:operators' : 'typesense:operators:empty'

      const payload = {
        operators: results.map((r) => ({
          name: r.name,
          slug: r.slug,
          primary_city_name: r.primary_city_name,
          primary_state_name: r.primary_state_name,
          primary_city_slug: r.primary_city_slug,
          primary_state_slug: r.primary_state_slug,
          services: r.services,
          phone: r.phone,
          tier: r.tier,
          description_text: r.description_text,
          distance_miles: r.distance_miles,
        })),
        data_freshness: {
          indexed_at: indexedAt,
          source,
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
