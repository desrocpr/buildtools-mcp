# Enrolling for BuildTools MCP

This is the one-time setup that lets Claude act on your BuildTools account.
You do it **once per BuildTools-password rotation**, in a browser.

## Quick start

1. Open: **https://buildtools-mcp.mossbuildinganddesign.com/enroll**
2. Click **Sign in with Microsoft**, sign in with your `@mossbuildinganddesign.com` account.
3. Paste your **BuildTools email + password** into the form.
4. Click **Connect BuildTools**. You'll see a confirmation page.

That's it. The next time you ask Claude to do anything BuildTools-related, it
authenticates as you automatically.

## What just happened

- Microsoft verified you are who you say you are (Moss tenant only).
- The server tested your BuildTools credentials by attempting a real login.
- Your BuildTools password was encrypted (AES-256-GCM) and stored in our
  Supabase project, keyed to your Moss identity.
- The plaintext password is held in memory only as long as the validation
  takes. The encryption key lives in Doppler, not in the database.

## Connecting Claude Desktop

Claude Desktop discovers the MCP via OAuth automatically. Add the MCP server
to your Claude Desktop config and the first tool call will pop a Microsoft
sign-in window:

```json
{
  "mcpServers": {
    "buildtools": {
      "url": "https://buildtools-mcp.mossbuildinganddesign.com/sse"
    }
  }
}
```

After that, the desktop app caches a token and you only sign in again when
the refresh token expires (~30 days).

## Re-enrolling

You need to re-enroll **only when**:

- Your BuildTools password changes (rotated, reset).
- You forgot you enrolled and want to confirm it's still active — visit
  `/enroll/status`.
- An admin asked you to.

The flow is identical to the first time. Submitting the form replaces your
stored credentials.

## Troubleshooting

### "Sign-in failed" after Microsoft redirect

The state token sealed for the round-trip through Microsoft has a 90-second
TTL. If your sign-in took longer (hardware key with presence check, slow
MFA), just hit the **Sign in with Microsoft** button again — that issues a
fresh state.

### "BuildTools authentication failed" on submit

The credentials don't work against `moss.buildtools.app`. Common causes:

- Typo in the email or password.
- Account was disabled on the BuildTools side.
- Password was rotated and you're entering the old one.

Try logging in directly at https://moss.buildtools.app to confirm the
credentials. Then come back to `/enroll` and retry.

### Claude says it can't reach BuildTools

The credentials might be stale or your role doesn't allow the tool you're
asking for. Check `/enroll/status` — if it says **Not enrolled**, re-enroll.
If it says **Connected** but a specific tool says "Permission denied",
your role doesn't grant it; ask an admin.

### "Permission denied: tool requires write:X"

You're enrolled but the tool you tried to invoke requires a permission your
role doesn't have. The default new-user role is **viewer** (read-only).
Email an admin (currently: pdesroches@mossbuildinganddesign.com) to request
**editor**.

## Privacy

- **Your BuildTools password** is encrypted and stored. Only the running MCP
  server can decrypt it (using the key in Doppler).
- **Audit log** records every tool call you make: when, what tool, what
  result, and which project (if applicable). Admins can see this log.
- The audit log does NOT record tool arguments beyond `project_id`. Your
  prompt text never leaves Claude.

## Revoking your enrollment

If you need to remove your credentials:

1. Email an admin to revoke your user. Or:
2. Sign in to BuildTools and rotate your password — your stored credential
   will then fail on next use, and you can re-enroll when ready.

## Admins only

If you're an admin, see [AUTH.md](./AUTH.md) for the operator surface
(`/admin/users`, `/admin/audit`, service-account provisioning).
