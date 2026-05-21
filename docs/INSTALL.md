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
