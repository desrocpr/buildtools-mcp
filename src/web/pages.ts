/**
 * Inline HTML templates for the enrollment + OAuth pages (MOS-328
 * Phase 4-5). Tailwind via CDN so we don't need a build step for
 * the static surface.
 *
 * Templates take simple parameter objects and produce escaped HTML.
 * `escape()` runs on every interpolation to prevent injection.
 */

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} — BuildTools MCP</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-50 text-slate-900">
  <div class="max-w-xl mx-auto px-6 py-12">
    <header class="mb-8">
      <a href="/enroll" class="text-sm text-slate-500 hover:text-slate-900">BuildTools MCP</a>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight">${escape(title)}</h1>
    </header>
    ${body}
    <footer class="mt-12 text-xs text-slate-400">
      Moss Building &amp; Design · MCP self-service
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function landingPage(): string {
  const body = `
    <p class="mb-6 text-slate-600">
      Connect your BuildTools account so Claude can act on your behalf.
    </p>
    <a href="/enroll/start"
       class="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-white font-medium hover:bg-blue-700">
      Sign in with Microsoft
    </a>
    <p class="mt-8 text-sm text-slate-500">
      You'll sign in with your <code>@mossbuildinganddesign.com</code> account and then
      enter your BuildTools email + password once. Your password is encrypted with
      AES-256-GCM and stored in our Supabase project — only the MCP server can
      decrypt it.
    </p>
  `;
  return layout("Enroll", body);
}

export interface CredentialsFormProps {
  userEmail: string;
  alreadyEnrolled: boolean;
  errorMessage?: string;
  prefillEmail?: string;
}

export function credentialsFormPage(props: CredentialsFormProps): string {
  const note = props.alreadyEnrolled
    ? `<p class="mb-6 rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
         You're already enrolled. Submitting this form will REPLACE your stored credentials.
       </p>`
    : "";
  const error = props.errorMessage
    ? `<p class="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-900">
         ${escape(props.errorMessage)}
       </p>`
    : "";
  const body = `
    <p class="mb-4 text-slate-600">
      Signed in as <strong>${escape(props.userEmail)}</strong>.
      <a class="ml-2 text-blue-600 hover:underline" href="/enroll/logout">Sign out</a>
    </p>
    ${error}
    ${note}
    <form method="POST" action="/enroll/save" class="space-y-4">
      <div>
        <label class="block text-sm font-medium" for="bt_email">BuildTools email</label>
        <input id="bt_email" name="bt_email" type="email" required autocomplete="off"
               value="${escape(props.prefillEmail ?? props.userEmail)}"
               class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
      </div>
      <div>
        <label class="block text-sm font-medium" for="bt_password">BuildTools password</label>
        <input id="bt_password" name="bt_password" type="password" required autocomplete="off"
               class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
        <p class="mt-1 text-xs text-slate-500">
          We validate the credentials by attempting a login against BuildTools,
          then encrypt + store the password. We never log or display it again.
        </p>
      </div>
      <button type="submit"
              class="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-white font-medium hover:bg-blue-700">
        Connect BuildTools
      </button>
    </form>
  `;
  return layout(props.alreadyEnrolled ? "Re-enroll" : "Connect BuildTools", body);
}

export interface StatusPageProps {
  userEmail: string;
  enrolled: boolean;
  buildtoolsEmail?: string;
  encryptedAt?: Date;
  roles: string[];
}

export function statusPage(props: StatusPageProps): string {
  const statusBlock = props.enrolled
    ? `<div class="rounded-md bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900 mb-6">
         <strong>Connected.</strong> BuildTools account
         <code>${escape(props.buildtoolsEmail ?? "?")}</code>
         enrolled${props.encryptedAt ? " " + escape(props.encryptedAt.toISOString().slice(0, 10)) : ""}.
       </div>`
    : `<div class="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900 mb-6">
         <strong>Not enrolled.</strong> Connect your BuildTools account below.
       </div>`;
  const body = `
    <p class="mb-6 text-slate-600">
      Signed in as <strong>${escape(props.userEmail)}</strong>.
      <a class="ml-2 text-blue-600 hover:underline" href="/enroll/logout">Sign out</a>
    </p>
    ${statusBlock}
    <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm mb-6">
      <dt class="text-slate-500">Roles</dt>
      <dd>${escape(props.roles.join(", ") || "(none)")}</dd>
    </dl>
    <div class="flex gap-3">
      <a href="/enroll" class="inline-flex items-center rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100">
        ${props.enrolled ? "Re-enroll" : "Connect BuildTools"}
      </a>
    </div>
  `;
  return layout("Status", body);
}

export function errorPage(message: string): string {
  const body = `
    <div class="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-900 mb-6">
      ${escape(message)}
    </div>
    <a href="/enroll" class="text-sm text-blue-600 hover:underline">Back to start</a>
  `;
  return layout("Error", body);
}

export const __test = { escape };
