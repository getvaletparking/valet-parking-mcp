/**
 * URL helpers for MCP tool responses. Single source of truth for
 * `?ref=mcp` UTM stamping (TOOL-12) applied to every operator URL
 * surfaced by ANY tool from Wave 10.2 onward.
 *
 * Per .planning/phases/10.2-mcp-simple-typesense-tools/10.2-CONTEXT.md
 * §decisions D-10.2-08: this is a pure module. No env access, no
 * fetches. The function is tested standalone in Plan 10.2-03
 * (__tests__/url.test.ts).
 *
 * Per D-10.2-09: uses URL constructor + searchParams.set('ref', 'mcp').
 * Idempotent: calling decorateOperatorUrl twice on the same URL
 * produces the same output. Handles existing query strings correctly:
 *   - 'https://example.com/'                       => 'https://example.com/?ref=mcp'
 *   - 'https://example.com/?utm_source=existing'   => 'https://example.com/?utm_source=existing&ref=mcp'
 *   - 'https://example.com/?ref=mcp'               => 'https://example.com/?ref=mcp'  (idempotent)
 *
 * Wave 10.4 extends the signature with optional sessionId + slug
 * parameters to also append `&ref_token={token}` (QUAL-04 referral
 * token minting). The additive-only signature change is forward
 * compatible: 10.2 callers pass one arg; 10.4 callers pass three.
 */

/**
 * Append `?ref=mcp` UTM parameter to an operator URL, with optional
 * referral_token append (Wave 10.4 QUAL-04 / D-10.4-05).
 *
 * @param url   - The operator website URL, or null/undefined for operators
 *                without a website field set.
 * @param token - Optional 16-char URL-safe referral token. When provided
 *                AND non-empty, appended as `&t=<token>`. Wave 10.4 mint
 *                site is tools/get-operator.ts; this plan only extends
 *                the signature so callers can stay forward-compatible.
 * @returns The decorated URL, or null if input was null/undefined/empty.
 * @throws TypeError if `url` is a non-empty string that fails the URL
 *         constructor. Callers (tool handlers) catch this and surface
 *         it as `upstream_unavailable` per D-10.2-10.
 */
export function decorateOperatorUrl(
  url: string | null | undefined,
  token?: string,
): string | null {
  if (url === null || url === undefined || url === '') {
    return null
  }
  const decorated = new URL(url)
  decorated.searchParams.set('ref', 'mcp')
  if (token !== undefined && token.length > 0) {
    decorated.searchParams.set('t', token)
  }
  return decorated.toString()
}
