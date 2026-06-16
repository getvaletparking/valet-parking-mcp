# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-16

### Added

- MCP server endpoint at `https://api.getvaletparking.com/mcp` with Streamable HTTP transport
- 7 tools: `valet_list_services`, `valet_get_operator`, `valet_search_cities`, `valet_find_operators_in_city`, `valet_search_by_service_and_city`, `valet_find_nearest_operators`, `valet_find_operators_near`
- Per-tool KV analytics counters tracking per-day call counts, per-session aggregates, and per-client mix
- Per-(IP, session) cost-points rate limit: 100 points / 60 second rolling window
- Per-IP abuse circuit: 1,000 calls/day for 2 consecutive days trips a 24-hour tarpit
- Per-tool kill switch via KV `mcp:tool_flags`; flipping a flag disables a single tool without redeploy
- Daily canary cron at 09:00 UTC probing initialize, tools/list, and 7 tools/call against fixtures; alerts via Resend on 5xx or schema drift after 2-day hysteresis
- Daily drift reconcile at 03:00 UTC writing `mcp:drift_flag` KV key; MCP responses gain `data_freshness.warning` at 1-5% drift and return a transient 503 at >5% drift
- Schema snapshot CI gating: `__snapshots__/*.json` per tool with vitest comparing live SDK-derived schemas against committed snapshots; PR diffs surface tool-contract changes
- `/.well-known/mcp/server-card.json` served from `https://api.getvaletparking.com`
- MIT LICENSE

[Unreleased]: https://github.com/getvaletparking/valet-parking-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/getvaletparking/valet-parking-mcp/releases/tag/v0.1.0
