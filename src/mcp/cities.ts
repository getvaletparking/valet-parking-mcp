/**
 * Cities search helper for MCP tools. Raw-fetch-to-Typesense pattern
 * copied from apps/workers/edge-api/src/routes/cities-suggest.ts lines
 * 38-110, adapted for the MCP tool output surface
 * (CityResult instead of CitySuggestion).
 *
 * Per .planning/phases/10.2-mcp-simple-typesense-tools/10.2-CONTEXT.md
 * §"Claude's Discretion":
 *   - query_by: 'name,name_lower' (matches cities-suggest.ts:60)
 *   - query_by_weights: '2,1'    (matches cities-suggest.ts:61)
 *   - sort_by: '_text_match:desc,population:desc' (cities-suggest.ts:62
 *     ensures Houston wins over Houma/Hoover on prefix 'hou' per roadmap
 *     success criterion #2)
 *
 * Per .planning/REQUIREMENTS.md TOOL-02: returns the city tuple
 * {slug, state_slug, lat, lng, population}.
 *
 * Throws Error(UPSTREAM_UNAVAILABLE_SENTINEL) on Typesense non-200 or
 * fetch throw. The MCP tool handler in 10.2-02 catches by message and
 * surfaces upstream_unavailable per D-10.2-10. Cities-suggest.ts uses
 * a different posture (return empty array on Typesense failure so the
 * autocomplete UX degrades silently); MCP tools cannot silently degrade
 * because agents would interpret empty results as "no matching cities."
 */
import { UPSTREAM_UNAVAILABLE_SENTINEL } from './operators.js'

/**
 * Local env shape for this helper. Mirrors the OperatorsHelperEnv
 * pattern from operators.ts; uses the same 2 Typesense bindings that
 * already exist in src/types.ts Env (no new bindings needed for cities
 * search; PAYLOAD_API_BASE_URL and PAYLOAD_API_KEY_BUILDER are only
 * for operators.ts).
 */
export interface CitiesHelperEnv {
  PUBLIC_TYPESENSE_HOST: string
  PUBLIC_TYPESENSE_SEARCH_KEY: string
}

/**
 * Output shape for valet_search_cities. The tool handler in 10.2-02
 * wraps an array of these in the standard envelope ({cities, data_freshness, _meta}).
 */
export interface CityResult {
  slug: string
  state_slug: string
  lat: number | null
  lng: number | null
  population: number
}

/**
 * Minimal Typesense response shape. Matches the cities-suggest.ts
 * shape verbatim because we hit the same cities collection.
 */
interface TypesenseSearchResponse {
  hits?: Array<{ document?: Record<string, unknown> }>
}

/**
 * Population-ranked city search via Typesense. Returns up to `limit`
 * results sorted by _text_match desc then population desc.
 *
 * Houston (pop 2.3M) beats Houma (pop 33k) on 'hou' prefix because
 * both score equally on _text_match (prefix match) but Houston wins
 * the population tiebreak.
 */
export async function searchCities(
  query: string,
  limit: number,
  env: CitiesHelperEnv,
): Promise<CityResult[]> {
  const tsUrl = `https://${env.PUBLIC_TYPESENSE_HOST}/collections/cities/documents/search`
  const params = new URLSearchParams({
    q: query,
    query_by: 'name,name_lower',
    query_by_weights: '2,1',
    sort_by: '_text_match:desc,population:desc',
    per_page: String(limit),
    include_fields: 'slug,state_slug,population,centroid',
  })

  let tsRes: Response
  try {
    tsRes = await fetch(`${tsUrl}?${params.toString()}`, {
      headers: { 'X-TYPESENSE-API-KEY': env.PUBLIC_TYPESENSE_SEARCH_KEY },
    })
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }
  if (!tsRes.ok) {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  let data: TypesenseSearchResponse
  try {
    data = (await tsRes.json()) as TypesenseSearchResponse
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  // Map hits to CityResult[]. centroid is a geopoint [lat, lng] tuple
  // in Typesense (per typesense-schema.cities.json). cities-suggest.ts
  // uses the same destructuring pattern at lines 86-93.
  const results: CityResult[] = (data.hits || []).map((h) => {
    const d = h.document ?? {}
    const centroid = Array.isArray(d.centroid) ? (d.centroid as unknown[]) : null
    const lat =
      centroid && centroid.length === 2 && typeof centroid[0] === 'number'
        ? (centroid[0] as number)
        : null
    const lng =
      centroid && centroid.length === 2 && typeof centroid[1] === 'number'
        ? (centroid[1] as number)
        : null
    return {
      slug: typeof d.slug === 'string' ? d.slug : '',
      state_slug: typeof d.state_slug === 'string' ? d.state_slug : '',
      lat,
      lng,
      population: typeof d.population === 'number' ? d.population : 0,
    }
  })

  return results
}
