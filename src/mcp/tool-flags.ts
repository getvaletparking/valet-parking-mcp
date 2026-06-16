/**
 * MCP per-tool kill switch flags. Per Phase 10.4-CONTEXT D-10.4-10:
 *   - Single KV key `mcp:tool_flags` holds a JSON blob
 *     `{tools: {valet_get_operator: "enabled", valet_find_operators_near: "disabled", ...}}`
 *   - Module-scoped const `_flagsCache` with 60s TTL
 *   - Atomic multi-tool toggle, single inspection point
 *     (wrangler kv key get --remote mcp:tool_flags)
 *
 * Per D-10.4-11: disabled tools are filtered from tools/list by the SDK's
 * native tool.enabled mechanism (mcp.js:68-69) AND short-circuited at
 * src/routes/mcp.ts with a 503 envelope BEFORE transport.handleRequest
 * dispatches. The SDK's default McpError(InvalidParams) -32602 envelope
 * is the alternative; we use 503 + {ok:false, code:'tool_disabled'} for
 * clearer UX.
 *
 * Fail-open posture: null KV blob (key never set) OR malformed JSON both
 * return {tools: {}} so the kill switch never accidentally takes down
 * the entire surface. The operator must explicitly write a flag to disable.
 *
 * Isolate lifecycle: CF Workers V8 isolates may run for minutes to hours;
 * the same isolate handles many requests. Cache lives for the isolate's
 * lifetime, refreshed every 60s. Kill switch propagation is up to 60s
 * per edge isolate (documented in docs/mcp-analytics-cookbook.md by
 * Plan 10.4-05).
 *
 * Test discipline: _resetToolFlagsCache is exported for vitest beforeEach.
 * Underscore prefix discourages non-test callers; comments below mark
 * it test-only.
 */
import type { Env } from '../types.js'

export type ToolFlag = 'enabled' | 'disabled'

export interface ToolFlags {
  tools: Partial<Record<string, ToolFlag>>
}

const CACHE_TTL_MS = 60 * 1000 // 60 seconds per D-10.4-10

let _flagsCache: { value: ToolFlags; expiresAt: number } | null = null

/**
 * Read the current tool flags, using the 60s in-isolate cache when fresh.
 * Fail-open on null OR malformed KV blob: returns {tools: {}} which the
 * route handler interprets as "all tools enabled."
 */
export async function getToolFlags(env: Env): Promise<ToolFlags> {
  const now = Date.now()
  if (_flagsCache !== null && _flagsCache.expiresAt > now) {
    return _flagsCache.value
  }

  const raw = await env.RATE_LIMIT.get('mcp:tool_flags')
  let value: ToolFlags
  if (raw === null) {
    value = { tools: {} } // fail-open: empty blob means all enabled
  } else {
    try {
      const parsed = JSON.parse(raw) as { tools?: unknown }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof parsed.tools === 'object' &&
        parsed.tools !== null
      ) {
        value = { tools: parsed.tools as Partial<Record<string, ToolFlag>> }
      } else {
        console.warn(
          '[tool-flags] mcp:tool_flags KV blob shape unexpected; failing open',
        )
        value = { tools: {} }
      }
    } catch {
      console.warn('[tool-flags] mcp:tool_flags KV blob malformed JSON; failing open')
      value = { tools: {} }
    }
  }

  _flagsCache = { value, expiresAt: now + CACHE_TTL_MS }
  return value
}

/**
 * internal: test-only. Reset the in-isolate cache so vitest can manipulate
 * KV between cases without 60s staleness bleeding across tests.
 * Same pattern as setMcpEnv test exposure in env-context.ts.
 */
export function _resetToolFlagsCache(): void {
  _flagsCache = null
}
