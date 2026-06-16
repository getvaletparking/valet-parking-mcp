/**
 * Tool: valet_search_by_service_and_city
 *
 * Typesense filter-query lookup for operators offering a service in a city,
 * with CROSS-STATE UNION semantics. Per Phase 10.3-CONTEXT:
 *   - D-10.3-01: 10-field OperatorSummary per row, NO website
 *   - D-10.3-03: NO primary_state_slug filter. Springfield returns operators
 *                across MO, IL, MA, OH, CO, etc. Agent's LLM disambiguates
 *                via primary_state_name + primary_state_slug per row.
 *   - D-10.3-04: sort tier:desc,name:asc
 *   - D-10.3-05: service_slug REQUIRED (not optional); enum derived from SERVICES_CATALOG
 *   - D-10.3-06: city_slug regex /^[a-z0-9-]+$/ enforced in handler BEFORE fetch
 *   - D-10.3-07: empty array is success, NOT isError
 *   - D-10.3-08: limit zod-clamped 1-50, default 10
 *   - D-10.3-11: output envelope {operators, data_freshness, _meta}
 *
 * Error model: 2 classes (invalid_input via in-handler regex; upstream_unavailable
 * via UPSTREAM_UNAVAILABLE_SENTINEL catch).
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  searchByServiceAndCity,
  UPSTREAM_UNAVAILABLE_SENTINEL,
} from '../operators.js'
import { getMcpEnv } from '../env-context.js'
import { SERVICES_CATALOG } from '../services-catalog.js'

// TOOL-09 description: <=300 chars, verb-object first, "Use this when..." second, no em-dashes.
const VALET_SEARCH_BY_SERVICE_AND_CITY_DESCRIPTION =
  'Search valet operators by service slug plus city slug across all matching states. ' +
  'Use this when an agent has both a service slug and a city slug and wants a cross-state ' +
  'tier-then-name ranked list. Invalid service slugs surface the 9 canonical alternatives.'
// Verified em-dash-free; <=300 chars.

const SLUG_REGEX = /^[a-z0-9-]+$/

const SERVICE_SLUGS = SERVICES_CATALOG.map((s) => s.slug) as [string, ...string[]]

const INVALID_SERVICE_MESSAGE =
  "Invalid service_slug: Valid slugs are: wedding-valet, corporate-event-valet, " +
  "private-event-valet, funeral-valet, hotel-resort-valet, restaurant-valet, " +
  "hospital-medical-valet, major-venue-valet, general-valet."

const outputSchema = z.object({
  operators: z
    .array(
      z.object({
        name: z.string().describe('Operator business name'),
        slug: z.string().describe('Canonical kebab-case operator slug'),
        primary_city_name: z.string().describe('Display name of operator HQ city'),
        primary_state_name: z.string().describe('Display name of operator HQ state'),
        primary_city_slug: z.string().describe('Canonical kebab-case HQ city slug'),
        primary_state_slug: z.string().describe('Canonical kebab-case HQ state slug; key disambiguation field'),
        services: z.array(z.string()).describe('Canonical service slugs this operator offers'),
        phone: z.string().nullable().describe('Operator phone number, null if not on file'),
        tier: z.string().describe("Operator tier: 'free', 'paid', or 'premium'"),
        description_text: z.string().nullable().describe('Plain-text summary; null if not on file'),
      }),
    )
    .describe(
      'Operators offering service_slug in any city matching city_slug across all states. ' +
        'Empty array means no matches.',
    ),
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

export function registerSearchByServiceAndCity(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_search_by_service_and_city',
    {
      title: 'Search By Service And City',
      description: VALET_SEARCH_BY_SERVICE_AND_CITY_DESCRIPTION,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        service_slug: z
          .enum(SERVICE_SLUGS, { errorMap: () => ({ message: INVALID_SERVICE_MESSAGE }) })
          .describe(
            'Required canonical valet service slug. One of 9 values; call valet_list_services for the full set.',
          ),
        city_slug: z
          .string()
          .min(1)
          .describe(
            "Lowercase kebab-case city slug (e.g. 'austin', 'springfield'). May match multiple cities across states.",
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
      const { service_slug, city_slug, limit } = args as {
        service_slug: string
        city_slug: string
        limit: number
      }

      // D-10.3-06: regex validation in handler BEFORE upstream fetch.
      // (service_slug already validated by zod enum at parse time.)
      if (!SLUG_REGEX.test(city_slug)) {
        return invalidSlugError('city_slug')
      }

      let results
      try {
        results = await searchByServiceAndCity(service_slug, city_slug, limit, getMcpEnv())
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
