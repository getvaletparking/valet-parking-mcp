/**
 * Operator data access helpers for MCP tools. Hybrid Typesense + Payload
 * REST fetch with Payload-wins merge per
 * .planning/phases/10.2-mcp-simple-typesense-tools/10.2-CONTEXT.md
 * §decisions D-10.2-01 through D-10.2-04.
 *
 * Why hybrid: keeping the Typesense schema search-optimized (16 fields,
 * no 500-char description or 8-item faqs[]) requires fetching long-tail
 * fields from Payload separately. Promise.all parallelizes so cold-edge
 * latency is max(Typesense, Payload), not the sum (D-10.2-02).
 *
 * Why Payload wins on overlap: Payload is the system of record;
 * Typesense is a cached search view that gvp-drift-check (Phase 02.5)
 * reconciles back to Payload nightly. If a recent admin edit lands in
 * Payload before Typesense sync catches up, returning the Payload value
 * matches what the admin sees in /admin/ (D-10.2-03).
 *
 * Why PAYLOAD_API_KEY_BUILDER reuse: the existing read-scoped key from
 * Phase 01 + 02.6 already grants /api/operators access (D-10.2-04).
 * 10.2-02 Task 5 uploads it to the gvp-edge-api Worker via
 *   wrangler secret put PAYLOAD_API_KEY_BUILDER --name gvp-edge-api
 * (operator runbook lives in 10.2-03 DEPLOY-EVIDENCE).
 */

/**
 * Local env shape for this helper. The formal Env extension lands in
 * Plan 10.2-02 Task 5 (src/types.ts grows PAYLOAD_API_BASE_URL +
 * PAYLOAD_API_KEY_BUILDER). Using a local type alias here keeps this
 * plan compiling independently and surfaces the exact bindings the
 * helper consumes.
 */
export interface OperatorsHelperEnv {
  PUBLIC_TYPESENSE_HOST: string
  PUBLIC_TYPESENSE_SEARCH_KEY: string
  PAYLOAD_API_BASE_URL: string
  PAYLOAD_API_KEY_BUILDER: string
}

/**
 * Sentinel error message thrown when either upstream returns non-200
 * or throws. The MCP tool handler in 10.2-02 catches by .message string
 * and surfaces the `upstream_unavailable` 3-class taxonomy entry
 * (D-10.2-10). Using a sentinel string instead of a custom Error
 * subclass keeps the helper portable (no class identity dance across
 * module boundaries in the Workers bundle).
 */
export const UPSTREAM_UNAVAILABLE_SENTINEL = 'upstream_unavailable'

/**
 * Shape of the merged operator profile returned to the tool handler.
 * Field semantics:
 *   - Fields 1-16 come from Typesense by default; Payload overwrites
 *     the 7 overlapping fields (name, slug, services, tier, verified,
 *     claimed, phone) on merge per D-10.2-03.
 *   - Fields 17-22 (the 6 long-tail fields) come from Payload only.
 *   - typesense_indexed_at is preserved verbatim from Typesense for
 *     the data_freshness stamp the tool handler in 10.2-02 builds.
 *
 * The tool handler in 10.2-02 shapes the public output (omits Payload
 * id + Lexical description AST, includes the plaintext description_text
 * from Typesense + the address/website/etc from Payload). This type
 * captures the FULL merged shape; the public zod outputSchema is a
 * subset.
 */
export interface OperatorProfile {
  // Typesense fields (16)
  id: string
  name: string
  slug: string
  primary_city_name: string
  primary_state_name: string
  primary_city_slug: string
  primary_state_slug: string
  service_area_city_slugs: string[]
  service_area_count: number
  services: string[]
  tier: string
  verified: boolean
  claimed: boolean
  phone: string | null
  description_text: string | null
  photo_url: string | null
  updated_at: number
  typesense_indexed_at: number
  // Payload long-tail fields (6); null when Payload returns nothing
  // OR when the operator legitimately lacks that field
  address: string | null
  website: string | null
  venues_served: Array<{ venue: string }>
  faqs: Array<{ question: string; answer: string; source?: string }>
  buyer_question_phrasings: Record<string, string> | null
}

/**
 * Operator summary shape returned by the array helpers
 * (findOperatorsInCity + searchByServiceAndCity). Per Phase 10.3-CONTEXT
 * D-10.3-01: 10 Typesense fields per row, NO website (Payload-only field
 * is fetched via valet_get_operator drill-down). The agent calls
 * valet_get_operator(slug) when it needs the website + long-tail fields.
 *
 * Shape is forward-compatible with Wave 10.4 geo tools: the geo tools
 * add distance_miles to each row and reuse this base shape.
 */
export interface OperatorSummary {
  name: string
  slug: string
  primary_city_name: string
  primary_state_name: string
  primary_city_slug: string
  primary_state_slug: string
  services: string[]
  phone: string | null
  tier: string
  description_text: string | null
  typesense_indexed_at: number
}

/**
 * Minimal Typesense response shape we read off. We do not validate the
 * full schema; we trust the cluster (single-tenant; we own the schema).
 */
interface TypesenseSearchResponse {
  hits?: Array<{ document?: Record<string, unknown> }>
}

/**
 * Minimal Payload REST response shape. depth=1 is locked per D-10.2-09
 * adjacent (the venues_served and faqs arrays are inline; primary_city
 * is a relationship but is also in Typesense as a slug pair, so we
 * do not need its full doc here).
 */
interface PayloadOperatorListResponse {
  docs?: Array<Record<string, unknown>>
  totalDocs?: number
}

/**
 * Hybrid operator fetch by slug. Returns the merged profile or null
 * when not found in either upstream. Throws Error(UPSTREAM_UNAVAILABLE_SENTINEL)
 * when either upstream returns non-200 or the fetch itself throws.
 *
 * Latency budget: max(Typesense, Payload) per D-10.2-02.
 *   - Typesense filter search: ~50-100ms cold, ~10-30ms warm
 *   - Payload REST depth=1 search: ~150-300ms cold, ~40-80ms warm
 */
export async function getOperatorBySlug(
  slug: string,
  env: OperatorsHelperEnv,
): Promise<OperatorProfile | null> {
  // Build the two URLs upfront so we can fire them in parallel.
  const typesenseUrl =
    `https://${env.PUBLIC_TYPESENSE_HOST}/collections/operators/documents/search?` +
    new URLSearchParams({
      q: '*',
      filter_by: `slug:=${slug}`,
      per_page: '1',
    }).toString()

  const payloadUrl =
    `${env.PAYLOAD_API_BASE_URL}/api/operators?` +
    new URLSearchParams({
      'where[slug][equals]': slug,
      depth: '1',
      limit: '1',
    }).toString()

  // Promise.all parallelism (D-10.2-02). If either upstream throws,
  // Promise.all rejects with the first error; we catch outside and
  // re-throw the upstream_unavailable sentinel.
  let tsRes: Response
  let payloadRes: Response
  try {
    ;[tsRes, payloadRes] = await Promise.all([
      fetch(typesenseUrl, {
        headers: { 'X-TYPESENSE-API-KEY': env.PUBLIC_TYPESENSE_SEARCH_KEY },
      }),
      fetch(payloadUrl, {
        headers: {
          Authorization: `users API-Key ${env.PAYLOAD_API_KEY_BUILDER}`,
        },
      }),
    ])
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  // Non-200 from EITHER upstream is treated as upstream_unavailable.
  // We do not partially-degrade: a Payload-only hit without Typesense
  // metadata would have a broken data_freshness stamp and a Typesense
  // hit without the Payload long-tail would silently drop the 6 fields
  // the tool advertises. The agent retry on upstream_unavailable is
  // safer than a partial response.
  if (!tsRes.ok || !payloadRes.ok) {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  let tsData: TypesenseSearchResponse
  let payloadData: PayloadOperatorListResponse
  try {
    ;[tsData, payloadData] = await Promise.all([
      tsRes.json() as Promise<TypesenseSearchResponse>,
      payloadRes.json() as Promise<PayloadOperatorListResponse>,
    ])
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  const tsHit = (tsData.hits || [])[0]?.document ?? null
  const payloadDoc = (payloadData.docs || [])[0] ?? null

  // not_found: zero hits in BOTH upstreams. Tool handler maps null
  // return to the not_found 3-class error envelope (D-10.2-10).
  if (tsHit === null && payloadDoc === null) {
    return null
  }

  // Merge: start with Typesense shape, overwrite with Payload values
  // on overlap (D-10.2-03). Typesense-only rows (Payload drift) get
  // Typesense data with null long-tail fields. Payload-only rows
  // (Typesense drift) get Payload data with the operator id but no
  // typesense_indexed_at; we synthesize the stamp from updated_at
  // (the Payload doc carries its own updated_at via Payload's automatic
  // timestamp).
  const tsRow = tsHit ?? ({} as Record<string, unknown>)
  const pdRow = payloadDoc ?? ({} as Record<string, unknown>)

  // Helper: pull a string field with a typed fallback chain.
  const str = (v: unknown, fallback: string | null = null): string | null =>
    typeof v === 'string' && v.length > 0 ? v : fallback
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

  // primary_city in Payload is a relationship object (when depth=1);
  // we DO NOT need it because Typesense has primary_city_slug etc as
  // flat strings. Payload-only path uses the relationship object.
  const payloadPrimaryCity = pdRow.primary_city as
    | { name?: string; slug?: string; state?: { name?: string; slug?: string } }
    | string
    | undefined
  const fallbackCityName =
    typeof payloadPrimaryCity === 'object' && payloadPrimaryCity !== null
      ? str(payloadPrimaryCity.name)
      : null
  const fallbackCitySlug =
    typeof payloadPrimaryCity === 'object' && payloadPrimaryCity !== null
      ? str(payloadPrimaryCity.slug)
      : null
  const fallbackStateName =
    typeof payloadPrimaryCity === 'object' && payloadPrimaryCity !== null
      ? str(payloadPrimaryCity.state?.name)
      : null
  const fallbackStateSlug =
    typeof payloadPrimaryCity === 'object' && payloadPrimaryCity !== null
      ? str(payloadPrimaryCity.state?.slug)
      : null

  const profile: OperatorProfile = {
    // id: Typesense uses the Payload doc id; either source is fine.
    id: str(tsRow.id) ?? str(pdRow.id) ?? '',
    // Payload wins on overlap (D-10.2-03)
    name: str(pdRow.name) ?? str(tsRow.name) ?? '',
    slug: str(pdRow.slug) ?? str(tsRow.slug) ?? slug,
    // Typesense provides the flat slugs; fall back to Payload relation
    // shape if Typesense missed the row entirely.
    primary_city_name: str(tsRow.primary_city_name) ?? fallbackCityName ?? '',
    primary_state_name: str(tsRow.primary_state_name) ?? fallbackStateName ?? '',
    primary_city_slug: str(tsRow.primary_city_slug) ?? fallbackCitySlug ?? '',
    primary_state_slug: str(tsRow.primary_state_slug) ?? fallbackStateSlug ?? '',
    service_area_city_slugs: arr(tsRow.service_area_city_slugs).filter(
      (x): x is string => typeof x === 'string',
    ),
    service_area_count: num(tsRow.service_area_count, 0),
    // services in Payload is an array of relationship objects; in
    // Typesense it is an array of slug strings. Payload wins per D-10.2-03
    // but we map the relationship objects to slugs first.
    services: (() => {
      const payloadServices = arr(pdRow.services)
        .map((entry) => {
          if (typeof entry === 'string') return entry
          if (typeof entry === 'object' && entry !== null) {
            const slugField = (entry as { slug?: unknown }).slug
            if (typeof slugField === 'string') return slugField
          }
          return null
        })
        .filter((s): s is string => s !== null)
      if (payloadServices.length > 0) return payloadServices
      return arr(tsRow.services).filter(
        (x): x is string => typeof x === 'string',
      )
    })(),
    tier: str(pdRow.tier) ?? str(tsRow.tier) ?? 'free',
    verified: bool(pdRow.verified, bool(tsRow.verified, false)),
    claimed: bool(pdRow.claimed, bool(tsRow.claimed, false)),
    phone: str(pdRow.phone) ?? str(tsRow.phone),
    // Typesense has the plaintext shadow; Payload has the Lexical AST.
    // The MCP tool surfaces plaintext only (D-10.2-03 + 02.4 Lexical
    // adapter precedent); pass Typesense's value verbatim. If Typesense
    // missed it, we leave null (the 10.2-02 zod outputSchema marks
    // description_text as optional/nullable).
    description_text: str(tsRow.description_text),
    photo_url: str(tsRow.photo_url),
    updated_at: num(tsRow.updated_at, 0),
    typesense_indexed_at: num(tsRow.typesense_indexed_at, num(tsRow.updated_at, 0)),
    // Payload long-tail fields (Payload only; Typesense has no shadow)
    address: str(pdRow.address),
    website: str(pdRow.website),
    venues_served: arr(pdRow.venues_served)
      .map((entry) => {
        if (typeof entry === 'object' && entry !== null) {
          const venue = (entry as { venue?: unknown }).venue
          if (typeof venue === 'string') return { venue }
        }
        return null
      })
      .filter((v): v is { venue: string } => v !== null),
    faqs: arr(pdRow.faqs)
      .map((entry): { question: string; answer: string; source?: string } | null => {
        if (typeof entry === 'object' && entry !== null) {
          const e = entry as { question?: unknown; answer?: unknown; source?: unknown }
          if (typeof e.question === 'string' && typeof e.answer === 'string') {
            const base: { question: string; answer: string; source?: string } = {
              question: e.question,
              answer: e.answer,
            }
            if (typeof e.source === 'string') {
              base.source = e.source
            }
            return base
          }
        }
        return null
      })
      .filter(
        (f): f is { question: string; answer: string; source?: string } => f !== null,
      ),
    buyer_question_phrasings:
      typeof pdRow.buyer_question_phrasings === 'object' &&
      pdRow.buyer_question_phrasings !== null &&
      !Array.isArray(pdRow.buyer_question_phrasings)
        ? (pdRow.buyer_question_phrasings as Record<string, string>)
        : null,
  }

  return profile
}

/**
 * Tier ranking for client-side sort: premium > paid > free > unknown.
 * Schema constraint workaround: tier is a string facet (sort:null) so
 * Typesense cannot sort by it server-side without a schema patch +
 * reindex. We sort by updated_at on the wire, then apply tier+name
 * ordering in the helper so the public contract (D-10.3-04: premium
 * first, name asc within tier) holds.
 */
const TIER_RANK: Record<string, number> = { premium: 3, paid: 2, free: 1 }

function sortOperatorsByTierThenName(rows: OperatorSummary[]): OperatorSummary[] {
  return rows.slice().sort((a, b) => {
    const ar = TIER_RANK[a.tier] ?? 0
    const br = TIER_RANK[b.tier] ?? 0
    if (ar !== br) return br - ar
    return a.name.localeCompare(b.name)
  })
}

/**
 * Map a raw Typesense document into the OperatorSummary shape. Pure;
 * trusts the Typesense schema we own (apps/typesense/typesense-schema.operators.json).
 * Defensive nulling on optional fields keeps the helper resilient against
 * sparsely-indexed rows.
 */
function mapOperatorSummary(doc: Record<string, unknown>): OperatorSummary {
  const str = (v: unknown, fallback: string | null = null): string | null =>
    typeof v === 'string' && v.length > 0 ? v : fallback
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  return {
    name: str(doc.name) ?? '',
    slug: str(doc.slug) ?? '',
    primary_city_name: str(doc.primary_city_name) ?? '',
    primary_state_name: str(doc.primary_state_name) ?? '',
    primary_city_slug: str(doc.primary_city_slug) ?? '',
    primary_state_slug: str(doc.primary_state_slug) ?? '',
    services: arr(doc.services),
    phone: str(doc.phone),
    tier: str(doc.tier) ?? 'free',
    description_text: str(doc.description_text),
    typesense_indexed_at: num(doc.typesense_indexed_at, num(doc.updated_at, 0)),
  }
}

/**
 * Typesense filter query for operators serving a (state, city) pair,
 * with optional service narrowing. Per Phase 10.3-CONTEXT D-10.3-02:
 * matches by service_area_city_slugs + primary_state_slug (NOT
 * primary_city_slug) so every operator who serves the city shows up
 * regardless of HQ location. Mirrors /valet-parking/{state}/{city}/
 * page semantics.
 *
 * Sort per D-10.3-04 (premium first, name asc within tier): the
 * operators schema marks tier + name as sort:null, so Typesense
 * cannot satisfy the contract server-side. We use updated_at:desc
 * on the wire (always-sortable default_sorting_field) and reorder
 * the mapped rows client-side via sortOperatorsByTierThenName.
 * Returns empty array on 0 matches per D-10.3-07. Throws
 * Error(UPSTREAM_UNAVAILABLE_SENTINEL) on fetch fail / non-200 /
 * JSON parse fail (single error class for array tools; not_found
 * does not apply, empty list is the truth).
 */
export async function findOperatorsInCity(
  stateSlug: string,
  citySlug: string,
  service: string | undefined,
  limit: number,
  env: OperatorsHelperEnv,
): Promise<OperatorSummary[]> {
  const filterParts = [
    `service_area_city_slugs:=${citySlug}`,
    `primary_state_slug:=${stateSlug}`,
  ]
  if (service !== undefined && service.length > 0) {
    filterParts.push(`services:=${service}`)
  }
  const filterBy = filterParts.join(' && ')

  const includeFields = [
    'name',
    'slug',
    'primary_city_name',
    'primary_state_name',
    'primary_city_slug',
    'primary_state_slug',
    'services',
    'phone',
    'tier',
    'description_text',
    'typesense_indexed_at',
  ].join(',')

  const url =
    `https://${env.PUBLIC_TYPESENSE_HOST}/collections/operators/documents/search?` +
    new URLSearchParams({
      q: '*',
      filter_by: filterBy,
      sort_by: 'updated_at:desc',
      include_fields: includeFields,
      per_page: String(limit),
    }).toString()

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'X-TYPESENSE-API-KEY': env.PUBLIC_TYPESENSE_SEARCH_KEY },
    })
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  if (!res.ok) {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  let data: TypesenseSearchResponse
  try {
    data = (await res.json()) as TypesenseSearchResponse
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  const hits = data.hits ?? []
  return sortOperatorsByTierThenName(
    hits.map((hit) => mapOperatorSummary(hit.document ?? {})),
  )
}

/**
 * Typesense filter query for operators offering a service across all
 * cities matching the slug, cross-state union. Per Phase 10.3-CONTEXT
 * D-10.3-03: NO primary_state_slug filter, Springfield returns
 * operators across MO, IL, MA, OH, CO, etc all in one list. Every
 * result row carries primary_state_name + primary_state_slug per
 * D-10.3-01 so the agent's LLM can group by state and disambiguate
 * conversationally.
 *
 * Sort per D-10.3-04 (premium first, name asc within tier): wire
 * sort is updated_at:desc (schema constraint, see findOperatorsInCity
 * for full rationale); client-side reorder via
 * sortOperatorsByTierThenName satisfies the contract. Returns empty
 * array on 0 matches per D-10.3-07. Throws
 * Error(UPSTREAM_UNAVAILABLE_SENTINEL) on fetch fail / non-200 /
 * JSON parse fail.
 */
export async function searchByServiceAndCity(
  serviceSlug: string,
  citySlug: string,
  limit: number,
  env: OperatorsHelperEnv,
): Promise<OperatorSummary[]> {
  const filterBy = `services:=${serviceSlug} && service_area_city_slugs:=${citySlug}`

  const includeFields = [
    'name',
    'slug',
    'primary_city_name',
    'primary_state_name',
    'primary_city_slug',
    'primary_state_slug',
    'services',
    'phone',
    'tier',
    'description_text',
    'typesense_indexed_at',
  ].join(',')

  const url =
    `https://${env.PUBLIC_TYPESENSE_HOST}/collections/operators/documents/search?` +
    new URLSearchParams({
      q: '*',
      filter_by: filterBy,
      sort_by: 'updated_at:desc',
      include_fields: includeFields,
      per_page: String(limit),
    }).toString()

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'X-TYPESENSE-API-KEY': env.PUBLIC_TYPESENSE_SEARCH_KEY },
    })
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  if (!res.ok) {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  let data: TypesenseSearchResponse
  try {
    data = (await res.json()) as TypesenseSearchResponse
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  const hits = data.hits ?? []
  return sortOperatorsByTierThenName(
    hits.map((hit) => mapOperatorSummary(hit.document ?? {})),
  )
}

/**
 * Operator summary shape returned by the geo helpers
 * (findNearestOperators + findOperatorsNear). Per Phase 10.4-CONTEXT
 * D-10.4-02: extends OperatorSummary with distance_miles attached
 * from Typesense's geo_distance_meters response field, converted via
 * meters / 1609.344 and rounded to 1 decimal (matches frontend
 * apps/frontend/src/lib/search-client.ts:210-213 precision).
 *
 * Wave 10.4+: forward-compatible base shape; future geo tools that
 * need additional sortable fields can extend this further.
 */
export interface OperatorSummaryWithDistance extends OperatorSummary {
  distance_miles: number
}

/**
 * Map a raw Typesense document + geo_distance_meters value into the
 * OperatorSummaryWithDistance shape. Reuses mapOperatorSummary for the
 * 11-field base shape, attaches distance_miles from the meters value.
 *
 * Conversion: 1 mile = 1609.344 meters (exact); rounded to 1 decimal
 * place to match the frontend display precision (search-client.ts:213).
 */
function mapOperatorSummaryWithDistance(
  doc: Record<string, unknown>,
  distanceMeters: number,
): OperatorSummaryWithDistance {
  const base = mapOperatorSummary(doc)
  return {
    ...base,
    distance_miles: Math.round((distanceMeters / 1609.344) * 10) / 10,
  }
}

/**
 * Sort operators by tier desc (premium > paid > free) then distance asc
 * within tier. Per Phase 10.4-CONTEXT D-10.4-02: TOOL-07 client-side
 * reorder. Reuses the TIER_RANK map declared above sortOperatorsByTierThenName.
 *
 * Used by findOperatorsNear (TOOL-07) before returning rows. NOT used
 * by findNearestOperators (TOOL-06): per D-10.4-02 the TOOL-06 contract
 * is "nearest first" with no tier weighting; wire sort already satisfies.
 */
function sortOperatorsByTierThenDistance(
  rows: OperatorSummaryWithDistance[],
): OperatorSummaryWithDistance[] {
  return rows.slice().sort((a, b) => {
    const ar = TIER_RANK[a.tier] ?? 0
    const br = TIER_RANK[b.tier] ?? 0
    if (ar !== br) return br - ar
    return a.distance_miles - b.distance_miles
  })
}

/**
 * Geo radius helper for TOOL-06 (valet_find_nearest_operators). Returns
 * up to `limit` operators within the 100mi sanity cap of (lat, lng),
 * sorted nearest-first on the wire (D-10.4-03 cap; D-10.4-02 contract).
 *
 * The 100mi cap is in the Typesense filter_by clause directly, not a
 * post-filter trim. This matches the public contract: "nearest first
 * within a sane radius" rather than "nearest first, ever, including
 * 300mi away for sparse-rural users." Empty result returns [].
 *
 * NO client-side reorder: TOOL-06 contract is nearest-first regardless
 * of tier (the agent asks "find me the closest"). TOOL-07 below applies
 * client-side tier reorder; TOOL-06 does not. Tier is still present in
 * each row for the agent to read.
 *
 * Distance extraction follows the proven pattern from
 * apps/frontend/src/lib/search-client.ts:210-213. Typesense returns
 * `geo_distance_meters.location` per hit at the envelope level (NOT
 * on the document), in meters. We divide by 1609.344 and round to 1
 * decimal place to match the frontend display precision.
 *
 * Throws Error(UPSTREAM_UNAVAILABLE_SENTINEL) on fetch fail / non-200 /
 * JSON parse fail (same single-error-class pattern as the 10.3 helpers).
 */
export async function findNearestOperators(
  lat: number,
  lng: number,
  service: string | undefined,
  limit: number,
  env: OperatorsHelperEnv,
): Promise<OperatorSummaryWithDistance[]> {
  const filterParts = [`location:(${lat},${lng},100 mi)`]
  if (service !== undefined && service.length > 0) {
    filterParts.push(`services:=${service}`)
  }
  const filterBy = filterParts.join(' && ')

  const includeFields = [
    'name',
    'slug',
    'primary_city_name',
    'primary_state_name',
    'primary_city_slug',
    'primary_state_slug',
    'services',
    'phone',
    'tier',
    'description_text',
    'typesense_indexed_at',
  ].join(',')

  const url =
    `https://${env.PUBLIC_TYPESENSE_HOST}/collections/operators/documents/search?` +
    new URLSearchParams({
      q: '*',
      filter_by: filterBy,
      sort_by: `location(${lat},${lng}):asc`,
      include_fields: includeFields,
      per_page: String(limit),
    }).toString()

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'X-TYPESENSE-API-KEY': env.PUBLIC_TYPESENSE_SEARCH_KEY },
    })
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  if (!res.ok) {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  let data: TypesenseSearchResponse
  try {
    data = (await res.json()) as TypesenseSearchResponse
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  const hits = data.hits ?? []
  return hits.map((hit) => {
    const distanceMeters =
      (hit as { geo_distance_meters?: { location?: number } }).geo_distance_meters
        ?.location ?? 0
    return mapOperatorSummaryWithDistance(hit.document ?? {}, distanceMeters)
  })
}

/**
 * Geo radius helper for TOOL-07 (valet_find_operators_near). Returns
 * up to `limit` operators within `radiusMiles` of (lat, lng), with
 * tier-then-distance client-side reorder (D-10.4-02).
 *
 * Per D-10.4-04 the agent picks radiusMiles based on context (5mi for
 * an event venue, 50mi for a regional sweep). No default; required arg.
 *
 * Per D-10.4-02 the public contract is "tier desc, distance asc within
 * tier" (premium operators lead even if slightly farther). Wire sort
 * is geopoint distance only (the operators schema marks tier as
 * sort:null); sortOperatorsByTierThenDistance applies the reorder
 * after mapping. This mirrors the 10.3 hotfix precedent for
 * sortOperatorsByTierThenName.
 *
 * Throws Error(UPSTREAM_UNAVAILABLE_SENTINEL) on fetch fail / non-200 /
 * JSON parse fail.
 */
export async function findOperatorsNear(
  lat: number,
  lng: number,
  radiusMiles: number,
  service: string | undefined,
  limit: number,
  env: OperatorsHelperEnv,
): Promise<OperatorSummaryWithDistance[]> {
  const filterParts = [`location:(${lat},${lng},${radiusMiles} mi)`]
  if (service !== undefined && service.length > 0) {
    filterParts.push(`services:=${service}`)
  }
  const filterBy = filterParts.join(' && ')

  const includeFields = [
    'name',
    'slug',
    'primary_city_name',
    'primary_state_name',
    'primary_city_slug',
    'primary_state_slug',
    'services',
    'phone',
    'tier',
    'description_text',
    'typesense_indexed_at',
  ].join(',')

  const url =
    `https://${env.PUBLIC_TYPESENSE_HOST}/collections/operators/documents/search?` +
    new URLSearchParams({
      q: '*',
      filter_by: filterBy,
      sort_by: `location(${lat},${lng}):asc`,
      include_fields: includeFields,
      per_page: String(limit),
    }).toString()

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'X-TYPESENSE-API-KEY': env.PUBLIC_TYPESENSE_SEARCH_KEY },
    })
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  if (!res.ok) {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  let data: TypesenseSearchResponse
  try {
    data = (await res.json()) as TypesenseSearchResponse
  } catch {
    throw new Error(UPSTREAM_UNAVAILABLE_SENTINEL)
  }

  const hits = data.hits ?? []
  const mapped = hits.map((hit) => {
    const distanceMeters =
      (hit as { geo_distance_meters?: { location?: number } }).geo_distance_meters
        ?.location ?? 0
    return mapOperatorSummaryWithDistance(hit.document ?? {}, distanceMeters)
  })
  return sortOperatorsByTierThenDistance(mapped)
}
