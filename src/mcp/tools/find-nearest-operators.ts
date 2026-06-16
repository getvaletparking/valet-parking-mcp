/**
 * Tool: valet_find_nearest_operators
 *
 * Distance-ranked operator lookup mirroring the empty-city fallback UX
 * for the 30,000+ cities with zero local operators. Per Phase 10.4-CONTEXT:
 *   - D-10.4-02: NO client-side tier reorder; contract is nearest-first
 *   - D-10.4-03: 100mi sanity cap hardcoded in the helper (founder override
 *               of Claude's 500mi recommendation; UX honesty over coverage breadth)
 *   - D-10.4-05: per-row website URL NOT surfaced (drill-down via valet_get_operator
 *               which mints the referral_token in Wave 10.4-04)
 *   - D-10.4-13: empty array success uses data_freshness.source = 'typesense:operators:empty'
 *
 * Error model: 1 class (upstream_unavailable via UPSTREAM_UNAVAILABLE_SENTINEL catch).
 * zod validates lat/lng/service/limit at parse time; invalid args surface as
 * SDK -32602 envelope.
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  findNearestOperators,
  UPSTREAM_UNAVAILABLE_SENTINEL,
} from '../operators.js'
import { getMcpEnv } from '../env-context.js'
import { SERVICES_CATALOG } from '../services-catalog.js'

// TOOL-09 description: <=300 chars, verb-object first, "Use this when..." second, no em-dashes.
const VALET_FIND_NEAREST_OPERATORS_DESCRIPTION =
  'List nearest valet operators within a 100-mile cap of a coordinate, optionally narrowed by service. ' +
  'Use this when a user is in a city with no listed operators and you need the closest available fallback ' +
  'ranked nearest-first. Empty array if nothing within 100 miles.'
// Verified em-dash-free; <=300 chars.

// Build the zod enum from the const-as-const SERVICES_CATALOG so adding a 10th
// slug to the catalog auto-extends this tool's accepted values.
const SERVICE_SLUGS = SERVICES_CATALOG.map((s) => s.slug) as [string, ...string[]]

// Canonical hand-written enumeration for the zod error message (mirrors
// the 10.3 find-operators-in-city + search-by-service-and-city pattern).
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
    .describe('Operators within 100 miles of the input coordinate, sorted nearest-first. Empty array means nothing within 100 miles.'),
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

export function registerFindNearestOperators(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_find_nearest_operators',
    {
      title: 'Find Nearest Operators',
      description: VALET_FIND_NEAREST_OPERATORS_DESCRIPTION,
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
        service: z
          .enum(SERVICE_SLUGS, { errorMap: () => ({ message: INVALID_SERVICE_MESSAGE }) })
          .optional()
          .describe(
            'Optional service narrowing. One of the 9 canonical valet service slugs. ' +
              'Omit to list every nearby operator regardless of services offered.',
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
      const { lat, lng, service, limit } = args as {
        lat: number
        lng: number
        service: string | undefined
        limit: number
      }

      let results
      try {
        results = await findNearestOperators(lat, lng, service, limit, getMcpEnv())
      } catch (err) {
        if (err instanceof Error && err.message === UPSTREAM_UNAVAILABLE_SENTINEL) {
          return upstreamUnavailableError()
        }
        return upstreamUnavailableError()
      }

      // Empty arrays still get data_freshness + _meta envelope per the
      // 10.3 D-10.3-11 precedent. Source tag 'typesense:operators:empty'
      // distinguishes empty-match from drift-suppressed responses (Wave 10.5).
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
