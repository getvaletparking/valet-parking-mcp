/**
 * Phase 10.5: MCP drift flag reader with 60s in-isolate cache.
 *
 * Reads the bucketed drift level written by the gvp-drift-check Worker
 * at KV key 'mcp:drift_flag' (Wave 10.5-01). The MCP route in
 * src/routes/mcp.ts dispatches on the level field:
 *   - 'ok'      -> no observable behavior change
 *   - 'warning' -> data_freshness.warning stamped onto every tools/call response
 *   - 'error'   -> 503 + JSON-RPC envelope returned BEFORE handleRequest fires
 *                  (blanket scope tools/call ONLY per D-10.5-07; tools/list +
 *                  initialize still succeed during an outage)
 *
 * Pattern parity: mirrors src/mcp/tool-flags.ts verbatim (60s TTL,
 * module-scoped const cache, Date.now() for expiry, fail-open posture).
 * The two reads share the same cheap-path region in the route handler.
 *
 * Fail-open posture:
 *   - null KV blob (key never set OR TTL expired) -> OK_FALLBACK
 *   - malformed JSON -> OK_FALLBACK + console.warn
 *   - shape validation failure -> OK_FALLBACK + console.warn
 * A silently-dead drift Worker MUST NOT bring down the public MCP surface.
 *
 * Date.now() is allowed in deployed CF Workers per D-10.4-10 footnote
 * (already used in tool-flags.ts; mirror exactly).
 */
import type { Env } from '../types.js'

export type DriftLevel = 'ok' | 'warning' | 'error'

export interface DriftFlag {
  level: DriftLevel
  drift_pct: number
  computed_at: string
  payload_count: number
  drift_count: number
}

const CACHE_TTL_MS = 60 * 1000 // 60s, same as getToolFlags
const KV_KEY = 'mcp:drift_flag'

const OK_FALLBACK: DriftFlag = {
  level: 'ok',
  drift_pct: 0,
  computed_at: '1970-01-01T00:00:00.000Z',
  payload_count: 0,
  drift_count: 0,
}

let _cache: { value: DriftFlag; expiresAt: number } | null = null

/**
 * Read the current drift flag from KV using the 60s in-isolate cache
 * when fresh. Fail-open on null OR malformed OR invalid-shape blob.
 */
export async function getDriftFlag(env: Env): Promise<DriftFlag> {
  const now = Date.now()
  if (_cache !== null && _cache.expiresAt > now) {
    return _cache.value
  }
  const raw = await env.RATE_LIMIT.get(KV_KEY)
  let value: DriftFlag
  if (raw === null) {
    // Missing key (TTL expired or never written): fail-open as ok.
    // A silently-dead drift Worker does NOT bring down the public MCP surface.
    value = OK_FALLBACK
  } else {
    try {
      const parsed = JSON.parse(raw) as Partial<DriftFlag>
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed.level === 'ok' ||
          parsed.level === 'warning' ||
          parsed.level === 'error') &&
        typeof parsed.drift_pct === 'number' &&
        typeof parsed.computed_at === 'string' &&
        typeof parsed.payload_count === 'number' &&
        typeof parsed.drift_count === 'number'
      ) {
        value = parsed as DriftFlag
      } else {
        console.warn('[drift-flag] mcp:drift_flag shape unexpected; failing open')
        value = OK_FALLBACK
      }
    } catch {
      console.warn('[drift-flag] mcp:drift_flag malformed JSON; failing open')
      value = OK_FALLBACK
    }
  }
  _cache = { value, expiresAt: now + CACHE_TTL_MS }
  return value
}

/**
 * Internal: test-only. Mirrors _resetToolFlagsCache for the symmetric
 * vitest beforeEach pattern in drift-flag.test.ts.
 */
export function _resetDriftFlagCache(): void {
  _cache = null
}
