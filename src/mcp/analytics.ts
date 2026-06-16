/**
 * MCP analytics counters and User-Agent classification. Per Phase 10.4-CONTEXT:
 *   - QUAL-01: per-tool per-day counter (mcp:analytics:${YYYYMMDD}:${tool})
 *   - QUAL-02: per-session-id key per day (mcp:sessions:${YYYYMMDD}:${sessionId}='1')
 *   - QUAL-03: per-client-bucket counter per day (mcp:client_mix:${YYYYMMDD}:${bucket})
 *   - D-10.4-13: hardcoded regex UA classifier (5 known clients + 'other' fallback)
 *
 * Race safety: CF Workers KV does NOT support atomic increment. At MCP scale
 * (<100 req/min expected year 1) the read-modify-write race window is
 * microseconds; we lose at most 1 count per concurrent-isolate collision.
 * The cookbook doc in Plan 10.4-05 notes the counters are approximate, not
 * exact. For billing-grade counters we would need Durable Objects (deferred
 * to Phase 12.1).
 *
 * Retention: 90 days. Cheap (KV storage is free under 1GB) and covers
 * monthly review with a buffer.
 *
 * Timezone: UTC (new Date().toISOString().slice(0,10) -> 'YYYY-MM-DD').
 * Documented in docs/mcp-analytics-cookbook.md (Plan 10.4-05).
 */
import type { Env } from '../types.js'

// D-10.4-13: hardcoded regex lookup. Adding a new client = one PR + redeploy.
// Order matters only for performance (first match wins; put hottest pattern first).
// Test ordering: 'Claude' first because Claude Desktop is the primary expected client.
export const UA_PATTERNS: Array<[RegExp, string]> = [
  [/Claude/i, 'claude-desktop'],
  [/Cursor/i, 'cursor'],
  [/ChatGPT/i, 'chatgpt'],
  [/Continue/i, 'continue'],
  [/Cline/i, 'cline'],
]

export function classifyUA(ua: string): string {
  for (const [re, name] of UA_PATTERNS) {
    if (re.test(ua)) return name
  }
  return 'other'
}

/**
 * UTC YYYY-MM-DD date string. Used as the date partition key for all
 * analytics + abuse-circuit KV keys.
 */
export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

const NINETY_DAYS_SECONDS = 60 * 60 * 24 * 90

/**
 * QUAL-01: per-tool per-day counter. GET + parseInt + PUT race window
 * is acceptable at MCP scale (see file header).
 */
export async function bumpToolCounter(
  kv: KVNamespace,
  tool: string,
  today: string,
): Promise<void> {
  const key = `mcp:analytics:${today}:${tool}`
  const raw = await kv.get(key)
  const parsed = raw !== null ? parseInt(raw, 10) : 0
  const count = Number.isFinite(parsed) ? parsed : 0
  await kv.put(key, String(count + 1), { expirationTtl: NINETY_DAYS_SECONDS })
}

/**
 * QUAL-02: per-session-id key per day. Idempotent: same session-id written
 * twice is one key. Counting unique sessions = wrangler kv key list with
 * prefix mcp:sessions:${today}: (paginated at 1000/page; cookbook doc
 * shows the recipe).
 */
export async function recordSession(
  kv: KVNamespace,
  sessionId: string,
  today: string,
): Promise<void> {
  const key = `mcp:sessions:${today}:${sessionId}`
  await kv.put(key, '1', { expirationTtl: NINETY_DAYS_SECONDS })
}

/**
 * QUAL-03: per-client-bucket counter per day. Same race-safety note as
 * bumpToolCounter.
 */
export async function bumpClientMix(
  kv: KVNamespace,
  bucket: string,
  today: string,
): Promise<void> {
  const key = `mcp:client_mix:${today}:${bucket}`
  const raw = await kv.get(key)
  const parsed = raw !== null ? parseInt(raw, 10) : 0
  const count = Number.isFinite(parsed) ? parsed : 0
  await kv.put(key, String(count + 1), { expirationTtl: NINETY_DAYS_SECONDS })
}

/**
 * Aggregate analytics write fired once per tools/call. The route handler
 * in src/routes/mcp.ts wraps this in c.executionCtx.waitUntil so the
 * response is not blocked on KV write latency.
 *
 * Sequential awaits are fine because all 3 writes go to the same KV
 * namespace and Workers does not parallelize KV operations meaningfully
 * (they share the underlying connection pool).
 */
export async function writeAnalytics(
  kv: KVNamespace,
  tool: string,
  ua: string,
  sessionId: string,
): Promise<void> {
  const today = todayUtcDate()
  const bucket = classifyUA(ua)
  await bumpToolCounter(kv, tool, today)
  await recordSession(kv, sessionId, today)
  await bumpClientMix(kv, bucket, today)
}

// `Env` import is used by the route handler that consumes this module;
// the export above does not directly reference it. Keep the import so
// TS module resolution succeeds without an unused warning (the file may
// add Env-typed helpers in future phases).
export type { Env }
