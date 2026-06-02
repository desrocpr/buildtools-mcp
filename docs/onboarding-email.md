# Onboarding email — Moss BuildTools MCP

Template for Paul to send out to other Moss employees when their accounts
are ready for rollout. Customize `[NAME]` and the closing.

---

**Subject**: Connect Claude to BuildTools — 60 seconds

Hi [NAME],

Claude can now act on your BuildTools account directly — listing projects,
reading change orders, creating selections, etc. — instead of you copying
and pasting data over.

To turn it on for yourself, **one-time setup**:

1. Open in a browser: **https://buildtools-mcp.mossbuildinganddesign.com/enroll**
2. Click **Sign in with Microsoft**, sign in with your Moss email.
3. Paste your **BuildTools email + password** into the form and hit
   **Connect BuildTools**.

That's it. Your password is encrypted at rest; only the MCP server can
read it.

After enrollment, add this to your Claude Desktop config (Settings →
Developer → Edit Config) under `mcpServers`:

```json
"buildtools": {
  "url": "https://buildtools-mcp.mossbuildinganddesign.com/sse"
}
```

Restart Claude Desktop. The first time you ask it to do something
BuildTools-related, it'll pop a Microsoft sign-in window — that's the OAuth
handshake. You won't see it again until ~30 days later.

**By default you get read-only access.** If you need write access (creating
change orders, selections, etc.), reply to this email and I'll bump your
role.

Questions or anything breaks, reply here. The full docs live at
https://buildtools-mcp.mossbuildinganddesign.com/enroll/status if you're
ever curious about your connection state.

Paul
