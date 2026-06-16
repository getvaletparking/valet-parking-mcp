/**
 * MCP server factory. Constructed ONCE at module scope and reused across
 * every /mcp request (per .planning/research/v1.2/SUMMARY.md
 * §"Architecture Decisions" → stateless transport pattern). McpServer holds
 * only tool definitions, no per-request state; safe to share across
 * isolates' lifetimes.
 *
 * MCP-03 (Plan 10.1): the CfWorkerJsonSchemaValidator opt-in is MANDATORY
 * on Cloudflare Workers. The SDK's default AJV validator calls
 * `new Function()` to compile schemas; Workers refuses with
 * `EvalError: Code generation from strings disallowed for this context`.
 * Without this, every `tools/call` with an input schema 500s on the first
 * production request.
 *
 * Wave 0 vertical slice: ONE tool registered (valet_list_services).
 * Wave 10.2+ adds get_operator, search_cities, etc. via the same factory.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
// IMPORTANT: import path is the bare specifier (NO `.js` suffix). The SDK
// package.json exports map exposes `"./validation/cfworker"` as the explicit
// entry pointing to `cfworker-provider.d.ts`. Appending `.js` falls through
// to the `"./*"` wildcard which tries `validation/cfworker.d.ts` (does not
// exist; the dist file is named `cfworker-provider.d.ts`) and fails TS2307.
// The bare specifier matches the explicit exports entry.
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { registerListServices } from './tools/list-services.js'
import { registerGetOperator } from './tools/get-operator.js'
import { registerSearchCities } from './tools/search-cities.js'
import { registerFindOperatorsInCity } from './tools/find-operators-in-city.js'
import { registerSearchByServiceAndCity } from './tools/search-by-service-and-city.js'
import { registerFindNearestOperators } from './tools/find-nearest-operators.js'
import { registerFindOperatorsNear } from './tools/find-operators-near.js'

/**
 * Build-time server identity. Version is the MCP server's own semver,
 * NOT the worker's git SHA; bump on every breaking-or-additive change
 * to the tool surface so Glama's auto-rescan picks it up.
 */
const SERVER_INFO = {
  name: 'getvaletparking',
  version: '1.0.0',
} as const

/**
 * Map of registered tool name to RegisteredTool ref. Populated by
 * createMcpServer at module load. Wave 10.4-03 kill switch reads this
 * Map in src/routes/mcp.ts to flip tool.enable()/.disable() based on
 * the mcp:tool_flags KV blob (D-10.4-10 + D-10.4-11).
 *
 * Per .planning/phases/10.4-mcp-geo-tools-analytics-and-abuse-circuit/10.4-RESEARCH.md
 * §"RegisteredTool ref tracking for kill switch": the SDK's tools/list
 * handler natively filters by tool.enabled at mcp.js:68-69 so we do NOT
 * need to wrap the tools/list response. We just need to flip enable/disable
 * on the refs before transport.handleRequest fires.
 */
export const registeredTools: Map<string, RegisteredTool> = new Map()

/**
 * Factory used at module load time (see exported `mcpServer` below).
 * Exposed for vitest so tests can construct an isolated server per case.
 *
 * IMPORTANT: this factory MUTATES the module-scoped registeredTools Map.
 * Calling createMcpServer twice in the same isolate (e.g. during vitest
 * with multiple `const server = createMcpServer()` calls) overwrites prior
 * entries. Tests that want isolated maps can clear `registeredTools` in
 * a beforeEach hook.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    // IMPORTANT: the ServerOptions field is `jsonSchemaValidator`, NOT
    // `validator`. The plan body called it `validator` (drift from an
    // imagined SDK API); the SDK 1.29.0 source (see
    // node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts
    // `ServerOptions.jsonSchemaValidator`) is the authoritative name.
    // Without this opt-in the SDK falls back to AjvJsonSchemaValidator,
    // which calls `new Function()` and crashes Workers at first elicitation.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    capabilities: {
      tools: { listChanged: false },
    },
  })
  registeredTools.set('valet_list_services', registerListServices(server))
  registeredTools.set('valet_get_operator', registerGetOperator(server))
  registeredTools.set('valet_search_cities', registerSearchCities(server))
  registeredTools.set('valet_find_operators_in_city', registerFindOperatorsInCity(server))
  registeredTools.set('valet_search_by_service_and_city', registerSearchByServiceAndCity(server))
  registeredTools.set('valet_find_nearest_operators', registerFindNearestOperators(server))
  registeredTools.set('valet_find_operators_near', registerFindOperatorsNear(server))
  // Wave 10.5+ append additional registeredTools.set(...) calls here.
  return server
}

/**
 * Module-scoped singleton. The Hono route handler in src/routes/mcp.ts
 * imports this directly; no per-request construction.
 */
export const mcpServer = createMcpServer()
