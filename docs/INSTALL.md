# Installing buildtools-mcp in Claude Desktop

## Prerequisites

- Node.js ≥ 18
- [Claude Desktop](https://claude.ai/download) installed

## Build

```bash
npm install
npm run build
# dist/index.js is now ready and executable
```

## Claude Desktop Configuration

Open (or create) your Claude Desktop config file:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add the `buildtools` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "buildtools": {
      "command": "node",
      "args": ["/absolute/path/to/buildtools-mcp/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/buildtools-mcp` with the actual path on your machine.

> **Note:** Environment variables for the BuildTools API (`BUILDTOOLS_TENANT`, etc.) will be added in Phase 2.

## Verification

1. Restart Claude Desktop after saving the config.
2. In Claude Desktop, type: **"Use the ping tool from buildtools."**
3. Claude should respond with **pong**.

If Claude reports that the tool is unavailable, check:

- The path in `args` is correct and `dist/index.js` exists.
- `dist/index.js` is executable (`chmod +x dist/index.js` if needed, or re-run `npm run build`).
- Claude Desktop was fully restarted after editing the config.

## HTTP/SSE transport

The default stdio transport is the right choice for Claude Desktop (one
process per user, credentials in `process.env`). For hosted agents that need
to share a single MCP server across many users, switch to the HTTP/SSE
transport by setting `MCP_TRANSPORT=http`.

### Environment variables

| Variable | Required for HTTP? | Default | Notes |
|---|---|---|---|
| `MCP_TRANSPORT` | yes (set to `http`) | `stdio` | Selects the transport. Any value other than `http` or `stdio` exits with an error. |
| `HTTP_PORT` | no | `3030` | TCP port the express server binds. |
| `HTTP_BEARER_TOKEN` | **yes** | — | The process exits non-zero at startup if `MCP_TRANSPORT=http` and this is missing. Required on every HTTP request as `Authorization: Bearer <token>`. |
| `BUILDTOOLS_TENANT` | no | — | Optional fallback tenant when a session omits `tenant` in `set_session_credentials`. |
| `BUILDTOOLS_USERNAME` / `BUILDTOOLS_PASSWORD` | **no** | — | Ignored by the HTTP transport. Credentials come from each session's handshake. |

### Two-layer auth

The HTTP transport enforces auth in two layers, both mandatory:

1. **Bearer token (server-level)** — every request to `/sse` or `/messages`
   must carry `Authorization: Bearer $HTTP_BEARER_TOKEN`. A missing or
   wrong header returns HTTP `401 Unauthorized`. The bearer proves the
   caller is a trusted MCP client; it does **not** grant any BuildTools
   access.

2. **Per-session BuildTools credentials (handshake)** — every SSE session
   must call the `set_session_credentials` tool before any
   BuildTools-bound tool will run for that session. Credentials live in
   memory keyed by the SDK-generated SSE `sessionId` and are wiped when
   the SSE connection closes.

### Session handshake

After the SSE stream is open, the client's first MCP tool call must be:

```json
{
  "name": "set_session_credentials",
  "arguments": {
    "username": "alice@example.com",
    "password": "<alice's BuildTools password>",
    "tenant": "moss"
  }
}
```

`tenant` is optional — if omitted, the server falls back to its
`BUILDTOOLS_TENANT` env var. Calling any other (non-`ping`) tool before
this handshake returns a Markdown error response prompting the client to
run `set_session_credentials` first.

### Audit log

Every tool dispatch writes one line to `stderr`:

```
[2026-05-27T20:00:00.000Z] audit sessionId=<id|stdio> user=<username|unauthenticated> tool=<name> result=<ok|error>
```

The BuildTools password and the bearer token never appear in the audit
line. A structured-log-file destination for production is a follow-up
concern, not part of Phase 6.

### Minimal hosted-run command

```bash
HTTP_BEARER_TOKEN=$(openssl rand -hex 32) \
MCP_TRANSPORT=http \
HTTP_PORT=3030 \
BUILDTOOLS_TENANT=moss \
node dist/index.js
```

Specific hosting-provider deployment guides (Vercel, Fly, Lightsail, etc.)
are intentionally deferred — pick the host that fits your platform and
inject the env vars above through its native secret mechanism.
