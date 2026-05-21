# buildtools-mcp

MCP server for BuildTools (third-party construction PM SaaS at `moss.buildtools.app`). Exposes BuildTools data + operations as tools/resources to Claude Desktop and other MCP-aware agents.

**Status:** scaffolding — Phase 1 (foundation) is the next issue to ship. See Linear project [BuildTools MCP](https://linear.app/mossbd/project/buildtools-mcp).

## What this is

This repo is a **TypeScript MCP server** that wraps a typed BuildTools client (rewritten from `desrocpr/buildtools`'s `api-client.js`) and exposes its operations as MCP tools.

```
Claude Desktop  ─stdio─►  buildtools-mcp  ─HTTPS─►  moss.buildtools.app
```

## Phases (per Linear project plan)

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: TS scaffold + stdio transport | not started |
| 2 | Typed BuildTools client + auth + tests | not started |
| 3 | Read tools (projects, financials, customers, attachments) | not started |
| 4 | Confirmation framework for mutations | deferred |
| 5 | Write tools (create/update project, attach files) | deferred |
| 6 | HTTP/SSE transport | deferred |
| 7 | Polish + smoke test | deferred |

Phases 1–3 ship as read-only MVP (~14 pts). Phases 4–7 follow as v2.

## Setup (after Phase 1 ships)

See `docs/INSTALL.md`. tl;dr — add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "buildtools": {
      "command": "node",
      "args": ["/absolute/path/to/buildtools-mcp/dist/index.js"],
      "env": {
        "BUILDTOOLS_TENANT": "moss",
        "BUILDTOOLS_USERNAME": "...",
        "BUILDTOOLS_PASSWORD": "..."
      }
    }
  }
}
```
