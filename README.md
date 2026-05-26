# buildtools-mcp

MCP server for BuildTools (third-party construction PM SaaS at `moss.buildtools.app`). Exposes BuildTools data + operations as tools/resources to Claude Desktop and other MCP-aware agents.

**Status:** Phase 1-3 shipped. Phase 4-7 deferred. See `STATE.md` for the full shipped tool list and the Linear project [BuildTools MCP](https://linear.app/mossbd/project/buildtools-mcp) for the remaining backlog.

## What this is

This repo is a **TypeScript MCP server** that wraps a typed BuildTools client (rewritten from `desrocpr/buildtools`'s `api-client.js`) and exposes its operations as MCP tools.

```
Claude Desktop  ─stdio─►  buildtools-mcp  ─HTTPS─►  moss.buildtools.app
```

## Phases (per Linear project plan)

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: TS scaffold + stdio transport | shipped |
| 2 | Typed BuildTools client + auth + tests | shipped |
| 3 | Read tools (projects, financials, customers, attachments) | shipped |
| 4 | Confirmation framework for mutations | deferred |
| 5 | Write tools (create/update project, attach files) | deferred |
| 6 | HTTP/SSE transport | deferred |
| 7 | Polish + smoke test | deferred |

Phase 1-3 shipped. Phase 4-7 deferred — filed as separate Linear issues.

## Setup

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
