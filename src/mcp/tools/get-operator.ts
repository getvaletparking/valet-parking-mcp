/**
 * Tool: valet_get_operator
 *
 * Returns the full operator profile by slug via hybrid Typesense + Payload
 * REST fetch (D-10.2-01). Implements TOOL-03 + TOOL-12 (?ref=mcp UTM stamp
 * on website) per .planning/REQUIREMENTS.md and the 3-class error taxonomy
 * (not_found / upstream_unavailable / invalid_input) per D-10.2-10.
 *
 * Per D-10.2-06: referral_token is NOT in the outputSchema. Wave 10.4
 * QUAL-04 adds the field + KV mint logic; this plan ships exactly what
 * the schema declares so the contract is clean.
 *
 * Per D-10.2-12: no slug-suggestion fuzzy on not_found. Wave 10.4 may
 * revisit after measuring 404 rate against real traffic.
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getOperatorBySlug,
  UPSTREAM_UNAVAILABLE_SENTINEL,
} from '../operators.js'
import { decorateOperatorUrl } from '../url.js'
import { getMcpEnv, getMcpSessionId } from '../env-context.js'
import { mintReferralToken, writeReferralKv } from '../referral-token.js'

// Description discipline (TOOL-09 + D-10.1-03 pattern):
//   - <=300 characters
//   - first sentence verb-then-object
//   - second sentence "Use this when..."
//   - no em-dashes (feedback_no_em_dashes memory + DOCS-09 gate)
//   - no HTML, no JSON examples, no behavior steering
const VALET_GET_OPERATOR_DESCRIPTION =
  'Get the full operator profile by slug including address, phone, website, ' +
  'services, venues_served, FAQs, and tipping note. Use this when an agent ' +
  'has a slug from a search tool or directory URL and needs the complete ' +
  'profile to rank or present. Returns isError on slug 404 or upstream outage.'
// Verified em-dash-free; <=300 chars.

// Slug regex (D-10.2-10 invalid_input class).
// Matches kebab-case slugs like '12-oaks-parking-llc', 'valet-pro-nyc'.
const SLUG_REGEX = /^[a-z0-9-]+$/

// Output schema, zod authoritative. CRITICAL: NO referral_token field
// (D-10.2-06 boundary with Wave 10.4 QUAL-04).
const outputSchema = z.object({
  operator: z
    .object({
      id: z.string().describe('Payload UUID; matches Typesense document id'),
      name: z.string().describe('Operator business name'),
      slug: z.string().describe('Canonical kebab-case slug; matches the input'),
      primary_city_name: z.string().describe('HQ proxy city display name'),
      primary_state_name: z.string().describe('HQ proxy state display name'),
      primary_city_slug: z.string().describe('HQ proxy city slug (URL-safe)'),
      primary_state_slug: z.string().describe('HQ proxy state slug (URL-safe)'),
      service_area_city_slugs: z
        .array(z.string())
        .describe('All city slugs this operator serves'),
      service_area_count: z.number().describe('Count of service-area cities'),
      services: z
        .array(z.string())
        .describe('Canonical service slugs from valet_list_services taxonomy'),
      tier: z.string().describe('Subscription tier: free | paid | custom'),
      verified: z.boolean().describe('Manual verification status'),
      claimed: z.boolean().describe('Operator-claim status'),
      phone: z.string().nullable().describe('E.164 phone number; null if none'),
      description_text: z
        .string()
        .nullable()
        .describe('Plaintext description; null if none. Lexical AST not exposed.'),
      photo_url: z.string().nullable().describe('Profile photo URL; null if none'),
      address: z.string().nullable().describe('Full street address; null if none'),
      website: z
        .string()
        .nullable()
        .describe('Operator website URL with ?ref=mcp UTM stamp (TOOL-12); null if none'),
      venues_served: z
        .array(z.object({ venue: z.string() }))
        .describe('Venues this operator regularly serves'),
      faqs: z
        .array(
          z.object({
            question: z.string(),
            answer: z.string(),
            source: z.string().optional(),
          }),
        )
        .describe('Structured FAQs; tipping guidance lives here as one entry'),
      buyer_question_phrasings: z
        .record(z.string())
        .nullable()
        .describe('LLM-seeded phrasings of buyer-checklist questions'),
    })
    .describe('The full merged operator profile (Typesense + Payload long-tail fields)'),
  data_freshness: z
    .object({
      indexed_at: z.string().describe('ISO datetime of the Typesense indexed_at stamp'),
      source: z.string().describe('Origin of the data; for this tool: typesense:operators'),
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
 * Build the not_found isError envelope per D-10.2-10.
 * Plain text content; no structuredContent (D-10.2-11).
 */
function notFoundError(slug: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Operator not found: ${slug}. ` +
          `Call valet_search_cities or valet_find_operators_in_city to discover valid slugs.`,
      },
    ],
    isError: true,
  }
}

/**
 * Build the upstream_unavailable isError envelope per D-10.2-10.
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
 * Build the invalid_input isError envelope per D-10.2-10.
 * Fires BEFORE any upstream fetch (saves cost-point and latency).
 */
function invalidInputError() {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          "Invalid slug format: slugs are lowercase kebab-case (e.g. '12-oaks-parking-llc').",
      },
    ],
    isError: true,
  }
}

/**
 * Register the valet_get_operator tool against the supplied McpServer.
 */
export function registerGetOperator(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_get_operator',
    {
      title: 'Get Operator Profile',
      description: VALET_GET_OPERATOR_DESCRIPTION,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe(
            "Canonical kebab-case operator slug (e.g. '12-oaks-parking-llc'). Lowercase letters, digits, hyphens only.",
          ),
      },
      outputSchema,
    },
    async (args) => {
      const { slug } = args as { slug: string }

      // D-10.2-10 invalid_input class: regex check BEFORE upstream fetch.
      // Saves upstream latency + Typesense/Payload load on garbage input.
      // Note: the per-tool cost-point is ALREADY deducted at the route
      // dispatch layer in src/routes/mcp.ts (V-05 method-gated, runs on
      // body.params.name before args parse). This handler check saves
      // the upstream fetch only, not the cost-point. Revision iteration 2
      // clarification per D-10.2-10.
      if (!SLUG_REGEX.test(slug)) {
        return invalidInputError()
      }

      let profile
      try {
        profile = await getOperatorBySlug(slug, getMcpEnv())
      } catch (err) {
        // D-10.2-10 upstream_unavailable class: getOperatorBySlug throws
        // Error(UPSTREAM_UNAVAILABLE_SENTINEL) on Typesense/Payload non-200
        // or fetch throw. We catch by message string to keep error
        // identity portable across module boundaries.
        if (err instanceof Error && err.message === UPSTREAM_UNAVAILABLE_SENTINEL) {
          return upstreamUnavailableError()
        }
        // Anything else (unexpected): also map to upstream_unavailable
        // rather than letting it bubble and 500 the worker. Agent gets
        // the retry hint either way.
        return upstreamUnavailableError()
      }

      // D-10.2-10 not_found class: null return from getOperatorBySlug
      // signals zero hits in BOTH Typesense and Payload.
      if (profile === null) {
        return notFoundError(slug)
      }

      // TOOL-12 + Plan 10.4-04 QUAL-04: stamp ?ref=mcp on the website URL
      // via decorateOperatorUrl. Phase 10.4 augments this with a referral_token
      // (D-10.4-05/06/07): mint a 16-char URL-safe token, write the KV
      // registry entry bound to (slug, session_id, minted_at) with 30-day TTL,
      // append the token to the URL as &t=${token}. The website's analytics
      // layer reads `t` from the query string and POSTs to /attribution/mcp
      // for ROI attribution.
      //
      // KV write failure is non-blocking: if writeReferralKv throws (KV outage),
      // we log + fall through to the legacy un-tokenized URL. The tool's
      // primary contract is "return the operator profile"; attribution is
      // best-effort.
      //
      // Token NOT minted when profile.website is null (no URL to surface).
      let decoratedWebsite: string | null
      try {
        if (profile.website !== null && profile.website.length > 0) {
          const token = mintReferralToken()
          try {
            await writeReferralKv(getMcpEnv(), token, profile.slug, getMcpSessionId())
            decoratedWebsite = decorateOperatorUrl(profile.website, token)
          } catch {
            console.warn(
              '[valet_get_operator] referral_token KV write failed; surfacing un-tokenized URL',
            )
            decoratedWebsite = decorateOperatorUrl(profile.website)
          }
        } else {
          decoratedWebsite = decorateOperatorUrl(profile.website)
        }
      } catch {
        return upstreamUnavailableError()
      }

      // TOOL-10 data_freshness stamp. typesense_indexed_at is the unix
      // milliseconds stamp from the Typesense schema (per
      // typesense-schema.operators.json). Convert to ISO string for the
      // public output (machine-readable + agent-friendly).
      const indexedAtIso =
        profile.typesense_indexed_at > 0
          ? new Date(profile.typesense_indexed_at).toISOString()
          : new Date(0).toISOString()

      const payload = {
        operator: {
          id: profile.id,
          name: profile.name,
          slug: profile.slug,
          primary_city_name: profile.primary_city_name,
          primary_state_name: profile.primary_state_name,
          primary_city_slug: profile.primary_city_slug,
          primary_state_slug: profile.primary_state_slug,
          service_area_city_slugs: profile.service_area_city_slugs,
          service_area_count: profile.service_area_count,
          services: profile.services,
          tier: profile.tier,
          verified: profile.verified,
          claimed: profile.claimed,
          phone: profile.phone,
          description_text: profile.description_text,
          photo_url: profile.photo_url,
          address: profile.address,
          // TOOL-12: stamped via decorateOperatorUrl above
          website: decoratedWebsite,
          venues_served: profile.venues_served,
          faqs: profile.faqs,
          buyer_question_phrasings: profile.buyer_question_phrasings,
        },
        data_freshness: {
          indexed_at: indexedAtIso,
          source: 'typesense:operators',
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
