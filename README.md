# valet-parking-directory

Public read-only MCP server backed by GetValetParking.com directory of US valet operators.

[![smithery badge](https://smithery.ai/badge/getvaletparking/valet-parking-directory)](https://smithery.ai/servers/getvaletparking/valet-parking-directory)

Find this server on the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers/com.getvaletparking/valet-parking-directory).

## What this is

GetValetParking.com directory exposes a Model Context Protocol server at `https://api.getvaletparking.com/mcp` over the Streamable HTTP transport. The server is public, read-only, and unauthenticated. It serves the same data that powers the directory pages at getvaletparking.com: 789 US valet operators across 31,186 cities, with 9 service taxonomies (wedding, corporate, restaurant, hotel, hospital, etc.).

Agents call it when a user asks about valet parking in a location. The server returns operator profiles with addresses, phone numbers, websites, services, FAQs, and tipping notes. Search by coordinate, by city slug, by service, or by name prefix.

## Install

### Claude Desktop

Edit your `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "valet-parking-directory": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.getvaletparking.com/mcp"
      ]
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "valet-parking-directory": {
      "url": "https://api.getvaletparking.com/mcp"
    }
  }
}
```

### ChatGPT (Pro, Team, Enterprise, or Edu)

In ChatGPT, go to Settings, then Apps and Connectors, then Add. Enter Name `valet-parking-directory` and URL `https://api.getvaletparking.com/mcp`. Steps may vary; refer to current ChatGPT documentation.

### Continue

Edit `.continue/config.yaml`:

```yaml
mcpServers:
  - name: valet-parking-directory
    type: streamable-http
    url: https://api.getvaletparking.com/mcp
```

### Cline

Cline GUI: MCP icon, Remote Servers tab, enter Server Name and Server URL. Or edit Cline MCP config JSON:

```json
{
  "mcpServers": {
    "valet-parking-directory": {
      "url": "https://api.getvaletparking.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Tools

| Tool | Title | Description | Cost (points) |
| --- | --- | --- | --- |
| `valet_list_services` | List Valet Services | List the 9 canonical valet service slugs with display name and category. Use this when an agent needs to validate or discover the supported service taxonomy before composing a follow-up search. Returns the in-bundle catalog; no upstream call; no isError path. | 1 |
| `valet_get_operator` | Get Operator | Get the full operator profile by slug including address, phone, website, services, venues_served, FAQs, and tipping note. Use this when an agent has a slug from a search tool or directory URL and needs the complete profile to rank or present. Returns isError on slug 404 or upstream outage. | 2 |
| `valet_search_cities` | Search Cities | Search the cities directory by name prefix with population-ranked results. Use this when an agent needs to resolve a partial city name into a canonical city slug plus state slug plus lat/lng before composing valet_find_operators_in_city or valet_find_operators_near. Empty array if no matches. | 1 |
| `valet_find_operators_in_city` | Find Operators in City | List valet operators serving a city slug plus state slug, optionally narrowed by service. Use this when an agent has a city already disambiguated and wants its operator roster ranked premium tier first then name. Empty array if no listed operators. | 1 |
| `valet_search_by_service_and_city` | Search by Service and City | Search valet operators by service slug plus city slug across all matching states. Use this when an agent has both a service slug and a city slug and wants a cross-state tier-then-name ranked list. Invalid service slugs surface the 9 canonical alternatives. | 1 |
| `valet_find_nearest_operators` | Find Nearest Operators | List nearest valet operators within a 100-mile cap of a coordinate, optionally narrowed by service. Use this when a user is in a city with no listed operators and you need the closest available fallback ranked nearest-first. Empty array if nothing within 100 miles. | 3 |
| `valet_find_operators_near` | Find Operators Near | Find valet operators within a given radius of a coordinate, ranked premium tier first then distance. Use this when you have a coordinate and an event-context radius (5mi single venue, 25mi metro, 50mi regional). radius_miles is required; empty array if no matches. | 3 |

Full per-tool documentation at `https://getvaletparking.com/mcp/docs`.

## Example transcripts

Three example transcripts capture the canonical first prompt "Find me valet parking near Austin, Texas" in three clients. Screenshots will land with the Phase 11 asset kit (target 2026-07).

### Claude Desktop

_Transcript screenshot will land with the Phase 11 asset kit (target 2026-07)._

### Cursor

_Transcript screenshot will land with the Phase 11 asset kit (target 2026-07)._

### ChatGPT

_Transcript screenshot will land with the Phase 11 asset kit (target 2026-07)._

Each transcript will show the prompt, the agent's tool call (`valet_find_nearest_operators` or `valet_search_cities` then `valet_find_operators_in_city`), and the readable result for the user.

## Data freshness

Operator data refreshes daily at 03:00 UTC via a Cloudflare Worker reconcile from Payload CMS to Typesense. The `data_freshness` field on every tool response includes the indexed_at timestamp plus source. If Payload-vs-Typesense drift exceeds 5%, tool responses return a transient 503 with retry-after; 1-5% drift adds a `data_freshness.warning` field with the current drift percentage. Server-card available at `https://api.getvaletparking.com/.well-known/mcp/server-card.json`.

## Rate limits and abuse circuit

The server enforces a per-(IP, session) cost-points budget of 100 points / 60 seconds rolling window. The cost table above lists the per-tool cost. Per-IP abuse circuit: more than 1,000 calls/day for 2 consecutive days trips a 24-hour tarpit. Per-tool kill switches are available to the operator as a manual override.

## Terms of use

Permitted: real-time agent queries grounded in a user intent.

Prohibited: bulk extraction, dataset construction for redistribution, scraping at scale, training-data construction, reposting on competing directories.

Full terms at `https://getvaletparking.com/mcp/terms`.

## License

MIT. See `LICENSE` at repo root.

## Source

This repo is a release-time mirror of the canonical source in the GetValetParking.com monorepo. The MCP server runs in production at `https://api.getvaletparking.com/mcp` from the same `src/mcp/` subtree present in this repo.

## Contact

`evans.keith@gmail.com`
