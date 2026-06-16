/**
 * MCP per-IP-per-day abuse circuit. Per Phase 10.4-CONTEXT:
 *   - D-10.4-08: tarpit = HTTP 429 + Retry-After: 86400. Trip condition:
 *     mcp:daily:${ip} > 1000 on day N AND day N-1. On trip, set
 *     mcp:tarpit:${ip}='1' with 24h TTL. Operator override: delete the
 *     tarpit KV key.
 *   - D-10.4-09: 2-consecutive-day lookback via daily KV keys.
 *     mcp:daily:${ip}:${YYYYMMDD} per-day counter with 48h TTL.
 *     On every tools/call, read today + yesterday, AND-gate > 1000.
 *
 * The route handler in src/routes/mcp.ts wires this in two places:
 *   STEP A (outermost gate): isTarpitted before checkRateLimit
 *   STEP D (post-budget, INSIDE tools/call branch per checker B-1):
 *     bumpDailyAndCheckTrip after kill switch + budget gate. tools/list,
 *     initialize, ping calls do NOT bump the counter, so a legitimate
 *     agent doing mostly tools/list calls is NOT false-positive tarpitted.
 *
 * Trip threshold is generous (>1000/day for 2 days = >2000 calls in 48h);
 * the override is trivial (delete the key); no log/enforce toggle needed
 * (unlike Phase 04.1-10 WORKER_INGRESS_MODE).
 *
 * Race safety: GET + parseInt + PUT race window same as analytics.ts.
 * At trip threshold (>1000/day) the abuser is making concurrent calls so
 * the counter undershoots slightly, but we sample more than enough to
 * detect the pattern across the 2-day window.
 */
import type { Env } from '../types.js'
import { todayUtcDate } from './analytics.js'

const TARPIT_TTL_SECONDS = 60 * 60 * 24 // 24 hours (D-10.4-08)
const DAILY_COUNTER_TTL_SECONDS = 60 * 60 * 48 // 48 hours (D-10.4-09 lookback window)
const TRIP_THRESHOLD = 1000

/**
 * Compute yesterday's UTC YYYY-MM-DD by subtracting 1 day. Today is
 * the partition key for the daily counter; yesterday is needed for the
 * 2-day AND-gate.
 */
function yesterdayUtcDate(today: string): string {
  // today is 'YYYY-MM-DD' UTC. Parse to Date, subtract 1 day, serialize.
  const todayDate = new Date(today + 'T00:00:00Z')
  const yesterday = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000)
  return yesterday.toISOString().slice(0, 10)
}

/**
 * STEP A: read tarpit flag. Outermost gate. Non-null means the route
 * handler returns 429 + Retry-After: 86400 before any other middleware.
 */
export async function isTarpitted(env: Env, ip: string): Promise<boolean> {
  const raw = await env.RATE_LIMIT.get(`mcp:tarpit:${ip}`)
  return raw !== null
}

/**
 * STEP D (tools/call branch only per checker B-1): bump today's daily
 * counter (+1), then check 2-day AND-gate. Sets mcp:tarpit:${ip}='1'
 * with 24h TTL on trip.
 *
 * Returns {tripped: true} when the AND-gate trips on THIS call (so the
 * route handler can short-circuit if desired; current design lets the
 * call complete and the tarpit gate catches subsequent calls). Returns
 * {tripped: false} on every other path.
 */
export async function bumpDailyAndCheckTrip(
  env: Env,
  ip: string,
): Promise<{ tripped: boolean }> {
  const today = todayUtcDate()
  const yesterday = yesterdayUtcDate(today)

  const todayKey = `mcp:daily:${ip}:${today}`
  const yesterdayKey = `mcp:daily:${ip}:${yesterday}`

  const rawToday = await env.RATE_LIMIT.get(todayKey)
  const parsedToday = rawToday !== null ? parseInt(rawToday, 10) : 0
  const todayCount = Number.isFinite(parsedToday) ? parsedToday : 0
  const newTodayCount = todayCount + 1
  await env.RATE_LIMIT.put(todayKey, String(newTodayCount), {
    expirationTtl: DAILY_COUNTER_TTL_SECONDS,
  })

  if (newTodayCount <= TRIP_THRESHOLD) {
    return { tripped: false }
  }

  // Today already over threshold; check yesterday.
  const rawYesterday = await env.RATE_LIMIT.get(yesterdayKey)
  const parsedYesterday = rawYesterday !== null ? parseInt(rawYesterday, 10) : 0
  const yesterdayCount = Number.isFinite(parsedYesterday) ? parsedYesterday : 0

  if (yesterdayCount > TRIP_THRESHOLD) {
    // 2-day AND-gate tripped. Set tarpit; subsequent calls hit STEP A.
    await env.RATE_LIMIT.put(`mcp:tarpit:${ip}`, '1', {
      expirationTtl: TARPIT_TTL_SECONDS,
    })
    return { tripped: true }
  }

  return { tripped: false }
}
