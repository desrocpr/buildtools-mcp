# Installing buildtools-mcp

This guide walks a fresh user through installing the BuildTools MCP server and
wiring it up to Claude Desktop end-to-end. Two transports are supported:

- **stdio** (default) — one process per Claude Desktop user. Credentials live
  in `claude_desktop_config.json` and never leave the user's machine.
- **HTTP/SSE** — single hosted server shared by multiple MCP clients. Each
  client authenticates with a bearer token and hands its own BuildTools
  credentials over the per-session handshake.

If you only care about Claude Desktop, follow sections 1-5 and stop. Section 6
is for hosted-agent deployments; section 7 collects the most common failure
modes.

## 1. Prerequisites

- **Node.js 22+** — the project targets Node 22 (see `tsconfig.json` and
  `@types/node@^22`). Older runtimes will fail to load the bundled SDK.
- **BuildTools credentials** — a working username + password on
  `moss.buildtools.app` (or your tenant's equivalent). The Phase 7 install
  guide does NOT create or rotate credentials for you; bring your own.
- **Claude Desktop** — install from <https://claude.ai/download> if you are
  using the stdio transport.
- **Optional: HTTP bearer token** — only needed if you plan to run the
  HTTP/SSE transport (section 6). Pick a high-entropy random string and keep
  it out of source control.

## 2. Clone + build

```bash
git clone https://github.com/desrocpr/buildtools-mcp.git
cd buildtools-mcp
npm install
npm run build
```

`npm run build` runs `tsc` against `tsconfig.json`, then the `postbuild` step
makes `dist/index.js` executable. If you re-pull changes later, re-run
`npm install && npm run build` — Claude Desktop reloads the file path each
time the app restarts.

## 3. Configure credentials

The server reads BuildTools credentials from environment variables. Two
patterns:

### 3.1 Local dev — `.env`

```bash
cp .env.example .env
# then edit .env and fill in BUILDTOOLS_USERNAME and BUILDTOOLS_PASSWORD
```

`.env.example` is the canonical reference for every environment variable the
server reads. Do NOT commit `.env` — it is gitignored.

This pattern is convenient when you run `node dist/index.js` by hand to
sanity-check the server outside Claude Desktop. Note that the Node runtime
does not automatically load `.env` — pair it with a loader (e.g.
`node --env-file=.env dist/index.js`) or export the values into your shell.

### 3.2 Production — Doppler

Production secrets live in the `buildtools-mcp` Doppler project. The server
expects them in the process environment, so `doppler run` is the canonical
launch wrapper:

```bash
doppler run --project buildtools-mcp --config prd -- node dist/index.js
```

Use the `dev` config locally to inherit the dev tenant's credentials:

```bash
doppler run --project buildtools-mcp --config dev -- node dist/index.js
```

Doppler injects every secret in the config as a process env var; the server
picks them up exactly as if they had been set in `.env`.

### 3.3 Optional — DB fast path (Phase 8)

When `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, and `MYSQL_DATABASE`
are set, the server builds a shared `MossDb` pool at startup and uses
it for all read-style tools (`project_status_brief`,
`cash_flow_forecast`, `uncollected_invoices`, plus the underlying
list/get tools). Reads against the MySQL replica are 30-100× faster
than the HTTP datatable path; portfolio-wide rollups drop from minutes
to seconds. See [STATE.md](../STATE.md) for the speedup table.

The secrets live in `buildtools/dev` (the parent reverse-engineering
repo) and are mirrored into `buildtools-mcp/prd`. Doppler injects
them automatically when running production; local dev can either
inherit them via `doppler run --project buildtools-mcp --config dev`
or leave them unset (the HTTP fallback works without DB).

Writes never use the DB regardless — they always go through the
authenticated BT HTTPS API with the calling user's credentials.

## 4. Claude Desktop config

Open (or create) the Claude Desktop config file:

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

Replace `/absolute/path/to/buildtools-mcp` with the actual repo path on your
machine, and fill in your BuildTools username / password under `env`. The
`env` block is per-user and stays on your machine — Claude Desktop launches
the server as a subprocess and exports these values into its environment
exactly like a shell would.

> If you'd rather not duplicate the credentials in `claude_desktop_config.json`
> (because they already live in Doppler), wrap the command with
> `doppler run --project buildtools-mcp --config dev --` and drop the `env`
> block. Doppler must be authenticated and `doppler setup` already run from
> this repo for that to work.

## 5. Verification

After saving the config, fully restart Claude Desktop (quit, don't just close
the window). Then in a new chat, run the two-step verification:

1. **Ping check** — prompt Claude with:

   > Use the ping tool from buildtools.

   Expected response: a single line of Markdown reading **`pong`**. This
   confirms the stdio transport handshake worked and that the server is
   reachable from Claude Desktop.

2. **List projects** — prompt Claude with:

   > List my recent BuildTools projects.

   Expected response: a Markdown bullet list of BuildTools projects, e.g.

   ```markdown
   **3 projects** (filtered 3 total, status: Active):

   - #100002 [Omega] Smith Kitchen Remodel — Springfield, VA — $ 42,500.00 contract value
   - #100007 [Alpha] Smith Pool House — Falls Church, VA — $ 138,500.00 contract value
   - #100012 [Nexus] Jones Addition — Vienna, VA — $ 245,500.50 contract value
   ```

   If this returns rows, BuildTools authentication is wired up correctly and
   the server has full read access.

   If you instead get an `Error calling list_projects` block, see section 7.

## 6. HTTP/SSE transport (hosted agents)

The default stdio transport is the right choice for Claude Desktop (one
process per user, credentials in `process.env`). For hosted agents that need
to share a single MCP server across many users, switch to the HTTP/SSE
transport by setting `MCP_TRANSPORT=http`.

### 6.1 Environment variables

| Variable | Required for HTTP? | Default | Notes |
|---|---|---|---|
| `MCP_TRANSPORT` | yes (set to `http`) | `stdio` | Selects the transport. Any value other than `http` or `stdio` exits with an error. |
| `HTTP_PORT` | no | `3030` | TCP port the express server binds. |
| `HTTP_BEARER_TOKEN` | **yes** | — | The process exits non-zero at startup if `MCP_TRANSPORT=http` and this is missing. Required on every HTTP request as `Authorization: Bearer <token>`. |
| `BUILDTOOLS_TENANT` | no | — | Optional fallback tenant when a session omits `tenant` in `set_session_credentials`. |
| `BUILDTOOLS_USERNAME` / `BUILDTOOLS_PASSWORD` | **no** | — | Ignored by the HTTP transport. Credentials come from each session's handshake. |

### 6.2 Run it

```bash
HTTP_BEARER_TOKEN=$(openssl rand -hex 32) \
MCP_TRANSPORT=http \
HTTP_PORT=3030 \
BUILDTOOLS_TENANT=moss \
npm start
```

`npm start` runs `node dist/index.js`. The process stays alive on its own via
the express listener; there is no daemonization layer. Use your platform's
process manager (systemd, pm2, Docker, Fly machines, …) to keep it running.

Specific hosting-provider deployment guides (Vercel, Fly, Lightsail, etc.) are
intentionally deferred — pick the host that fits your platform and inject the
env vars above through its native secret mechanism.

### 6.3 Connect from an MCP client

Point the client at `http://your-host:3030/sse` and add the bearer token:

```
GET /sse HTTP/1.1
Host: your-host:3030
Authorization: Bearer <HTTP_BEARER_TOKEN>
Accept: text/event-stream
```

### 6.4 Two-layer auth

The HTTP transport enforces auth in two layers, both mandatory:

1. **Bearer token (server-level)** — every request to `/sse` or `/messages`
   must carry `Authorization: Bearer $HTTP_BEARER_TOKEN`. A missing or wrong
   header returns HTTP `401 Unauthorized`. The bearer proves the caller is a
   trusted MCP client; it does **not** grant any BuildTools access.

2. **Per-session BuildTools credentials (handshake)** — every SSE session
   must call the `set_session_credentials` tool before any BuildTools-bound
   tool will run for that session. Credentials live in memory keyed by the
   SDK-generated SSE `sessionId` and are wiped when the SSE connection
   closes.

### 6.5 Session handshake

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
`BUILDTOOLS_TENANT` env var. Calling any other (non-`ping`) tool before this
handshake returns a Markdown error response prompting the client to run
`set_session_credentials` first.

### 6.6 Audit log

Every tool dispatch writes one line to `stderr`:

```
[2026-05-27T20:00:00.000Z] audit sessionId=<id|stdio> user=<username|unauthenticated> tool=<name> result=<ok|error>
```

The BuildTools password and the bearer token never appear in the audit line.
A structured-log-file destination for production is a follow-up concern, not
part of Phase 6.

## 7. Troubleshooting

### "Tool unavailable" / Claude does not see the buildtools server

1. Confirm the path in `args` is the absolute path to the built file
   (`<repo>/dist/index.js`), not the source TypeScript file.
2. Confirm `dist/index.js` exists and is executable. If not, re-run
   `npm run build` (which also runs `chmod +x` via the `postbuild` script).
3. Confirm Claude Desktop was fully quit and relaunched after editing
   `claude_desktop_config.json` — reopening a window is not enough.
4. Check Claude Desktop's MCP server logs (Developer menu → Show MCP logs)
   for spawn errors. A common cause is a wrong path or a Node version older
   than 22.

### Authentication errors (`BuildToolsAuthError: Not authenticated`)

1. Confirm `BUILDTOOLS_TENANT`, `BUILDTOOLS_USERNAME`, and `BUILDTOOLS_PASSWORD`
   are all set in the `env` block (or in the wrapping `doppler run` config).
2. Try logging in to `https://<tenant>.buildtools.app` in a browser with the
   same credentials. The MCP client uses the same form-login flow.
3. If MFA / SSO is enforced on the tenant for your user, the form-login flow
   will fail. Use a service user without MFA, or run the server through a
   pre-authenticated session (out of scope for this guide).

### Port already in use (HTTP transport)

If `npm start` fails with `EADDRINUSE`, another process is bound to
`HTTP_PORT`. Either:

- pick a different port: `HTTP_PORT=3031 npm start`, or
- find and stop the conflicting process: `lsof -i :3030` on macOS / Linux.

The default port is 3030, deliberately outside the 3000-3010 range Claude
Desktop reserves for its own dev servers.

### `HTTP_BEARER_TOKEN must be set when MCP_TRANSPORT=http`

The server refuses to start the HTTP transport without an explicit bearer
token — a missing token is a security bug, not a default. Generate one with
`openssl rand -hex 32` and inject it as an env var (or via your secret
manager / Doppler).

### Session calls return "Please call set_session_credentials first"

The HTTP transport requires each SSE session to call
`set_session_credentials` before any BuildTools-bound tool. If you skip the
handshake, every tool call (except `ping`) is rejected with a Markdown error
asking you to run the handshake. See section 6.5 for the payload.
