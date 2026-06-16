/**
 * MCP referral token mint + KV registry write. Per Phase 10.4-CONTEXT:
 *   - D-10.4-05: token lives ONLY inside the website URL as `&t=<token>`,
 *     NOT a separate field in valet_get_operator's outputSchema
 *   - D-10.4-06: redemption sink = edge-api Worker + Payload McpReferrals
 *     collection
 *   - D-10.4-07 (revised in 10.4-04 plan revision per checker M-5): 16-char
 *     URL-safe base64url token derived from
 *     `crypto.getRandomValues(new Uint8Array(12)) + btoa + base64url
 *     slice(16)` per Phase 10.4 RESEARCH §6. Functionally equivalent to the
 *     original wording (16-char URL-safe, ~10^28 keyspace); simpler than
 *     UUID-slice with no entropy waste from hyphens.
 *   - D-10.4-07: 30-day KV TTL; value JSON: {slug, session_id, minted_at}
 *
 * Per .planning/phases/10.4-mcp-geo-tools-analytics-and-abuse-circuit/10.4-RESEARCH.md
 * §"CF Workers Crypto": 12 random bytes -> base64 -> 16 chars exact (no
 * padding char to strip). Keyspace = 2^96 ~ 7.9e28; brute-force collision
 * is implausible.
 *
 * crypto.getRandomValues is the right primitive on Workers (cryptographically
 * safe RNG; Math.random is forbidden). crypto.randomUUID is also available
 * but wastes entropy in the hyphens.
 */
import type { Env } from '../types.js'

const REFERRAL_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days per D-10.4-07

/**
 * Generate a 16-char URL-safe base64url token. 12 random bytes base64-encode
 * to exactly 16 chars with no `=` padding (12 bytes = exact multiple of 3,
 * so base64 output has no padding). Two replaces convert standard base64 to
 * URL-safe.
 */
export function mintReferralToken(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .slice(0, 16)
}

/**
 * Write the KV registry entry for a minted token. Bound to (slug, session_id,
 * minted_at). 30-day TTL; subsequent /attribution/mcp redemption deletes the
 * key after writing the Payload row.
 */
export async function writeReferralKv(
  env: Env,
  token: string,
  slug: string,
  sessionId: string,
): Promise<void> {
  const payload = JSON.stringify({
    slug,
    session_id: sessionId,
    minted_at: Date.now(),
  })
  await env.RATE_LIMIT.put(`mcp:referral:${token}`, payload, {
    expirationTtl: REFERRAL_TTL_SECONDS,
  })
}
