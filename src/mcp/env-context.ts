/**
 * Module-scoped mutable env holder for MCP tool handlers.
 *
 * Why this exists: the McpServer factory + module-scoped singleton
 * (Plan 10.1-02 D-10.1-04 locked architecture) means tool handlers are
 * registered ONCE at module load and have no per-request access to
 * the Hono context's env. To reach the env (Typesense host, Payload
 * URL, API keys), tool handlers call getMcpEnv() and the route handler
 * in src/routes/mcp.ts MUST call setMcpEnv(c.env) BEFORE delegating
 * to transport.handleRequest(c) for every request.
 *
 * Why this is safe in Workers: V8 isolates handle one request at a
 * time within a single execution context. There is no concurrent
 * write window inside a single request. The mutable holder is
 * effectively request-scoped because setMcpEnv runs at the start of
 * each request before any tool handler can read it.
 *
 * Why null guard: if the route handler ever forgets to call
 * setMcpEnv (regression in src/routes/mcp.ts), the tool handler's
 * getMcpEnv() throws a clear error instead of silently dereferencing
 * undefined.PUBLIC_TYPESENSE_HOST.
 *
 * Wave 10.4+ may revisit this with a per-request McpServer if the
 * mutable holder becomes a constraint, but for 10.2-10.4 this is
 * the simplest viable bridge between request-scoped env and
 * module-scoped server.
 */
import type { Env } from '../types.js'

let currentEnv: Env | null = null

/**
 * Set the env for the current request. The route handler in
 * src/routes/mcp.ts calls this on every POST /mcp before delegating
 * to transport.handleRequest(c).
 */
export function setMcpEnv(env: Env): void {
  currentEnv = env
}

/**
 * Get the env set by the route handler. Tool handlers call this to
 * reach Typesense host + API keys + Payload base URL.
 *
 * Throws if called before setMcpEnv (regression in the route handler).
 * The error message names the route file so the failure is debuggable.
 */
export function getMcpEnv(): Env {
  if (currentEnv === null) {
    throw new Error(
      'MCP env not set; src/routes/mcp.ts must call setMcpEnv(c.env) before transport.handleRequest',
    )
  }
  return currentEnv
}

/**
 * Per-request Mcp-Session-Id holder. Used by tool handlers (e.g.
 * valet_get_operator) that need the session id for KV registry writes
 * (Phase 10.4 referral_token mint per D-10.4-07).
 *
 * Same safety rationale as setMcpEnv: V8 isolates handle one request at
 * a time; setMcpSessionId runs at request entry in src/routes/mcp.ts
 * before any tool handler can read it.
 */
let currentSessionId: string = 'init'

export function setMcpSessionId(id: string | null): void {
  currentSessionId = id !== null && id.length > 0 ? id : 'init'
}

export function getMcpSessionId(): string {
  return currentSessionId
}
