/**
 * Tool: valet_find_operators_in_city
 *
 * Typesense filter-query lookup mirroring the /valet-parking/{state}/{city}/
 * directory page. Per Phase 10.3-CONTEXT:
 *   - D-10.3-01: 10-field OperatorSummary per row, NO website (drill-down via valet_get_operator)
 *   - D-10.3-02: matches by service_area_city_slugs + primary_state_slug (NOT primary_city_slug)
 *   - D-10.3-04: sort tier:desc,name:asc (premium leads, alpha within tier)
 *   - D-10.3-05: service enum derived from SERVICES_CATALOG, invalid slug -> zod error with all 9 valid slugs enumerated
 *   - D-10.3-06: state_slug + city_slug regex /^[a-z0-9-]+$/ enforced in handler BEFORE upstream fetch
 *   - D-10.3-07: empty array is success, NOT isError
 *   - D-10.3-08: limit zod-clamped 1-50, default 10
 *   - D-10.3-11: output envelope {operators, data_freshness, _meta}
 *
 * Error model: 2 classes (invalid_input via in-handler regex; upstream_unavailable
 * via UPSTREAM_UNAVAILABLE_SENTINEL catch). No not_found, since empty list IS the truth.
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  findOperatorsInCity,
  UPSTREAM_UNAVAILABLE_SENTINEL,
} from '../operators.js'
import { getMcpEnv } from '../env-context.js'
import { SERVICES_CATALOG } from '../services-catalog.js'

// TOOL-09 description: <=300 chars, verb-object first, "Use this when..." second, no em-dashes.
const VALET_FIND_OPERATORS_IN_CITY_DESCRIPTION =
  'List valet operators serving a city slug plus state slug, optionally narrowed by service. ' +
  'Use this when an agent has a city already disambiguated and wants its operator roster ' +
  'ranked premium tier first then name. Empty array if no listed operators.'
// Verified em-dash-free; <=300 chars.

const SLUG_REGEX = /^[a-z0-9-]+$/

// Build the zod enum from the const-as-const SERVICES_CATALOG so adding a 10th
// slug to the catalog auto-extends this tool's accepted values (D-10.3-05).
const SERVICE_SLUGS = SERVICES_CATALOG.map((s) => s.slug) as [string, ...string[]]

// Canonical hand-written enumeration for the zod error message (D-10.3-05).
// Hardcoded (NOT interpolated from SERVICES_CATALOG) for human readability and
// to keep the bundle string deduplication-friendly per the CONTEXT decision.
const INVALID_SERVICE_MESSAGE =
  "Invalid service_slug: Valid slugs are: wedding-valet, corporate-event-valet, " +
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
      }),
    )
    .describe('Operators serving the city, ranked tier:desc then name:asc. Empty array means no matches.'),
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

function invalidSlugError(field: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Invalid ${field}: slugs are lowercase kebab-case (e.g. 'tx', 'houston').`,
      },
    ],
    isError: true,
  }
}

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

export function registerFindOperatorsInCity(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_find_operators_in_city',
    {
      title: 'Find Operators In City',
      description: VALET_FIND_OPERATORS_IN_CITY_DESCRIPTION,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        state_slug: z
          .string()
          .min(1)
          .describe("Lowercase kebab-case US state slug (e.g. 'tx', 'new-york')"),
        city_slug: z
          .string()
          .min(1)
          .describe("Lowercase kebab-case city slug (e.g. 'houston', 'san-francisco')"),
        service: z
          .enum(SERVICE_SLUGS, { errorMap: () => ({ message: INVALID_SERVICE_MESSAGE }) })
          .optional()
          .describe(
            'Optional service narrowing. One of the 9 canonical valet service slugs. ' +
              'Omit to list every operator serving the city.',
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
      const { state_slug, city_slug, service, limit } = args as {
        state_slug: string
        city_slug: string
        service: string | undefined
        limit: number
      }

      // D-10.3-06: regex validation in handler BEFORE upstream fetch.
      if (!SLUG_REGEX.test(state_slug)) {
        return invalidSlugError('state_slug')
      }
      if (!SLUG_REGEX.test(city_slug)) {
        return invalidSlugError('city_slug')
      }

      let results
      try {
        results = await findOperatorsInCity(state_slug, city_slug, service, limit, getMcpEnv())
      } catch (err) {
        if (err instanceof Error && err.message === UPSTREAM_UNAVAILABLE_SENTINEL) {
          return upstreamUnavailableError()
        }
        return upstreamUnavailableError()
      }

      // D-10.3-11: empty arrays still get data_freshness + _meta envelope.
      // Use a distinct source tag so Wave 10.5 drift detection can tell
      // empty-match from drift-suppressed responses.
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
