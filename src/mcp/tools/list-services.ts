/**
 * Tool: valet_list_services
 *
 * Returns the 9 canonical valet parking service categories from the in-bundle
 * catalog (no Typesense fetch; constant-time). The output is a stable triple
 * {slug, displayName, category} per service, plus the standard envelope:
 *   - data_freshness: { indexed_at, source }   (TOOL-10)
 *   - _meta:          { terms, attribution }   (TOOL-11)
 *
 * Plan 10.1-02 (Wave 0 vertical slice). Establishes the patterns Waves
 * 10.2-10.4 will copy onto Typesense-backed tools.
 *
 * Per D-10.1-05 (10.1-CONTEXT.md): no data_freshness.warning field yet,
 * because the drift detection mechanism that would set it lands in Wave 10.5.
 */
import { z } from 'zod'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SERVICES_CATALOG, SERVICES_CATALOG_INDEXED_AT } from '../services-catalog.js'

// Description discipline (TOOL-09 + D-10.1-03):
//   - <=300 characters (Glama Conciseness dimension)
//   - first sentence verb-object
//   - second sentence "Use this when..."
//   - no em-dashes (feedback_no_em_dashes memory + DOCS-09 gate)
//   - no HTML, no JSON examples, no behavior steering
const VALET_LIST_SERVICES_DESCRIPTION =
  'List the 9 canonical valet service slugs with display name and category. ' +
  'Use this when an agent needs to validate or discover the supported service ' +
  'taxonomy before composing a follow-up search (e.g. valet_search_by_service_and_city). ' +
  'Returns the in-bundle catalog; no upstream call; no isError path.'
// Verified em-dash-free; <=300 chars.

// Output schema, zod authoritative; SDK derives JSON Schema from this.
// IMPORTANT: pass the full ZodObject (this constant) to registerTool's
// outputSchema, NOT the ZodObject .shape property. Passing .shape (ZodRawShape) has
// caused silent serialization bugs in past SDK versions; the safe form is the
// full ZodObject reference (per the interfaces block above).
const outputSchema = z.object({
  services: z
    .array(
      z.object({
        slug: z.string().describe('Canonical kebab-case service slug (e.g. wedding-valet)'),
        displayName: z.string().describe('Human-readable service name'),
        category: z.string().describe('Broad grouping: event, corporate, hospitality, medical, venue, or general'),
      }),
    )
    .describe('The 9 canonical valet service types, in catalog order'),
  data_freshness: z
    .object({
      indexed_at: z.string().describe('YYYY-MM-DD when this catalog was last updated'),
      source: z.string().describe('Origin of the data, sourced from the in-bundle catalog'),
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
 * Register the valet_list_services tool against the supplied McpServer.
 * The tool takes no inputs and is fully constant-time (no upstream call,
 * no env access).
 */
export function registerListServices(server: McpServer): RegisteredTool {
  return server.registerTool(
    'valet_list_services',
    {
      title: 'List Valet Services',
      description: VALET_LIST_SERVICES_DESCRIPTION,
      // TOOL-08: required annotations on every tool
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      // Empty input schema, tool takes no arguments
      inputSchema: {},
      // Pass the full ZodObject (NOT .shape) per the interfaces note above.
      outputSchema,
    },
    async () => {
      const payload = {
        services: SERVICES_CATALOG.map((s) => ({
          slug: s.slug,
          displayName: s.displayName,
          category: s.category,
        })),
        // TOOL-10: data_freshness stamp
        data_freshness: {
          indexed_at: SERVICES_CATALOG_INDEXED_AT,
          source: 'in-bundle catalog',
        },
        // TOOL-11: ToS and attribution
        _meta: {
          terms: 'https://api.getvaletparking.com/mcp/terms',
          attribution: 'Powered by getvaletparking.com',
        },
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}
