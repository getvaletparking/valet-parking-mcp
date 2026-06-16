/**
 * Phase 10.6-02 (DOCS-06): hand-authored SERVER_CARD constant per D-10.6-09.
 *
 * This constant is the canonical identity record for the valet-parking-directory
 * MCP server. It is served from:
 *   GET https://api.getvaletparking.com/.well-known/mcp/server-card.json
 *
 * Drift defense: apps/workers/edge-api/src/mcp/__tests__/server-card.test.ts
 * asserts that every tools[].description matches the corresponding
 * __snapshots__/{tool}.json .description field verbatim (D-10.6-10).
 *
 * The 7 tool descriptions were polished in Phase 10.5 (GLAMA self-score 4.90
 * TDQS); they are copied here verbatim from the Phase 10.5 snapshot outputs.
 * Do NOT paraphrase or rewrite them without also updating the snapshot files
 * and re-running the drift-defense test.
 *
 * The description field (13-field union per D-10.6-09) is reused verbatim in
 * the Phase 11 SUB asset kit as the long-form server description for directory
 * submissions (Glama, Smithery, mcp.so, PulseMCP, mcpmarket.com, Composio).
 */

export const SERVER_CARD = {
  name: 'valet-parking-directory',
  description:
    'Public read-only MCP server backed by GetValetParking.com directory of 789 US valet parking operators across 31,186 cities. Discover operators by coordinates or city slug, filter by 9 service types, and fetch full operator profiles. No auth required; rate-limited per IP and session.',
  version: '0.1.0',
  homepage: 'https://getvaletparking.com/mcp/docs',
  documentation: 'https://github.com/getvaletparking/valet-parking-mcp#readme',
  repository: 'https://github.com/getvaletparking/valet-parking-mcp',
  license: 'MIT',
  transport: 'streamable-http',
  endpoint: 'https://api.getvaletparking.com/mcp',
  capabilities: { tools: true },
  contact: 'evans.keith@gmail.com',
  vendor: { name: 'GetValetParking', url: 'https://getvaletparking.com' },
  tools: [
    {
      name: 'valet_list_services',
      description:
        'List the 9 canonical valet service slugs with display name and category. Use this when an agent needs to validate or discover the supported service taxonomy before composing a follow-up search (e.g. valet_search_by_service_and_city). Returns the in-bundle catalog; no upstream call; no isError path.',
    },
    {
      name: 'valet_get_operator',
      description:
        'Get the full operator profile by slug including address, phone, website, services, venues_served, FAQs, and tipping note. Use this when an agent has a slug from a search tool or directory URL and needs the complete profile to rank or present. Returns isError on slug 404 or upstream outage.',
    },
    {
      name: 'valet_search_cities',
      description:
        'Search the cities directory by name prefix with population-ranked results. Use this when an agent needs to resolve a partial city name into a canonical city slug plus state slug plus lat/lng before composing valet_find_operators_in_city or valet_find_operators_near. Empty array if no matches.',
    },
    {
      name: 'valet_find_operators_in_city',
      description:
        'List valet operators serving a city slug plus state slug, optionally narrowed by service. Use this when an agent has a city already disambiguated and wants its operator roster ranked premium tier first then name. Empty array if no listed operators.',
    },
    {
      name: 'valet_search_by_service_and_city',
      description:
        'Search valet operators by service slug plus city slug across all matching states. Use this when an agent has both a service slug and a city slug and wants a cross-state tier-then-name ranked list. Invalid service slugs surface the 9 canonical alternatives.',
    },
    {
      name: 'valet_find_nearest_operators',
      description:
        'List nearest valet operators within a 100-mile cap of a coordinate, optionally narrowed by service. Use this when a user is in a city with no listed operators and you need the closest available fallback ranked nearest-first. Empty array if nothing within 100 miles.',
    },
    {
      name: 'valet_find_operators_near',
      description:
        'Find valet operators within a given radius of a coordinate, ranked premium tier first then distance. Use this when you have a coordinate and an event-context radius (5mi single venue, 25mi metro, 50mi regional). radius_miles is required; empty array if no matches.',
    },
  ],
} as const
