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

// ---------------------------------------------------------------------------
// Admin pages (MOS-328 Phase 7)
// ---------------------------------------------------------------------------

function adminHeader(userEmail: string): string {
  return `
    <p class="mb-6 text-sm text-slate-600">
      Signed in as <strong>${escape(userEmail)}</strong> (admin).
      <span class="ml-3 text-slate-300">·</span>
      <a class="ml-2 text-blue-600 hover:underline" href="/admin">Dashboard</a>
      <a class="ml-3 text-blue-600 hover:underline" href="/admin/users">Users</a>
      <a class="ml-3 text-blue-600 hover:underline" href="/admin/audit">Audit log</a>
      <a class="ml-3 text-blue-600 hover:underline" href="/admin/service-accounts/new">New service account</a>
      <a class="ml-3 text-slate-500 hover:text-slate-900" href="/enroll/logout">Sign out</a>
    </p>
  `;
}

export interface AdminPageProps {
  userEmail: string;
}

export function adminDashboardPage(props: AdminPageProps): string {
  const body = `
    ${adminHeader(props.userEmail)}
    <div class="grid grid-cols-1 gap-4">
      <a href="/admin/users" class="block rounded-md border border-slate-200 bg-white p-4 hover:border-blue-400">
        <h2 class="font-semibold">Users</h2>
        <p class="text-sm text-slate-600">List enrolled humans and service accounts. Assign or revoke roles.</p>
      </a>
      <a href="/admin/service-accounts/new" class="block rounded-md border border-slate-200 bg-white p-4 hover:border-blue-400">
        <h2 class="font-semibold">New service account</h2>
        <p class="text-sm text-slate-600">Provision a long-lived <code>mcps_…</code> bearer for headless callers (the harness).</p>
      </a>
      <a href="/admin/audit" class="block rounded-md border border-slate-200 bg-white p-4 hover:border-blue-400">
        <h2 class="font-semibold">Audit log</h2>
        <p class="text-sm text-slate-600">Recent tool calls, paginated by 50.</p>
      </a>
    </div>
  `;
  return layout("Admin", body);
}

export interface AdminUserRow {
  id: string;
  kind: "human" | "service";
  email: string;
  displayName: string | null;
  status: "active" | "revoked";
  lastSeenAt: Date | null;
  roles: Array<{ name: string }>;
}

export interface AdminUsersPageProps extends AdminPageProps {
  currentUserId: string;
  users: AdminUserRow[];
}

const KNOWN_ROLES = ["viewer", "editor", "admin", "harness"];

export function adminUsersPage(props: AdminUsersPageProps): string {
  const userRows = props.users
    .map((u) => {
      const isSelf = u.id === props.currentUserId;
      const roleNames = new Set(u.roles.map((r) => r.name));
      const roleBadges = u.roles
        .map(
          (r) =>
            `<form method="POST" action="/admin/users/${escape(u.id)}/role" class="inline">
               <input type="hidden" name="role" value="${escape(r.name)}">
               <input type="hidden" name="action" value="remove">
               <button type="submit" class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs hover:bg-red-100" title="Remove role">
                 ${escape(r.name)} <span class="text-slate-400">×</span>
               </button>
             </form>`,
        )
        .join(" ");
      const addRoleOptions = KNOWN_ROLES.filter((r) => !roleNames.has(r))
        .map((r) => `<option value="${escape(r)}">${escape(r)}</option>`)
        .join("");
      const addRoleForm = addRoleOptions
        ? `<form method="POST" action="/admin/users/${escape(u.id)}/role" class="inline">
             <input type="hidden" name="action" value="add">
             <select name="role" class="rounded border border-slate-300 px-1 py-0.5 text-xs">
               ${addRoleOptions}
             </select>
             <button type="submit" class="ml-1 rounded bg-blue-600 px-2 py-0.5 text-xs text-white hover:bg-blue-700">+</button>
           </form>`
        : `<span class="text-xs text-slate-400">(all roles assigned)</span>`;
      const revokeBtn =
        u.status === "active" && !isSelf
          ? `<form method="POST" action="/admin/users/${escape(u.id)}/revoke" class="inline" onsubmit="return confirm('Revoke ${escape(u.email)}? This signs them out + invalidates all their tokens.')">
               <button type="submit" class="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700">Revoke</button>
             </form>`
          : `<span class="text-xs text-slate-400">${escape(u.status)}</span>`;
      const lastSeen = u.lastSeenAt
        ? u.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")
        : "—";
      return `
        <tr class="border-t border-slate-100 ${u.status === "revoked" ? "opacity-60" : ""}">
          <td class="py-2 pr-3 align-top">
            <div class="font-medium">${escape(u.email)}</div>
            <div class="text-xs text-slate-500">${escape(u.displayName ?? "")}</div>
          </td>
          <td class="py-2 pr-3 align-top text-sm">${escape(u.kind)}</td>
          <td class="py-2 pr-3 align-top">${roleBadges} ${addRoleForm}</td>
          <td class="py-2 pr-3 align-top text-xs text-slate-500">${escape(lastSeen)}</td>
          <td class="py-2 align-top">${revokeBtn}</td>
        </tr>
      `;
    })
    .join("");

  const body = `
    ${adminHeader(props.userEmail)}
    <h2 class="text-lg font-semibold mb-3">${props.users.length} enrolled user${props.users.length === 1 ? "" : "s"}</h2>
    <div class="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th class="py-2 pl-3 pr-3">Email</th>
            <th class="py-2 pr-3">Kind</th>
            <th class="py-2 pr-3">Roles</th>
            <th class="py-2 pr-3">Last seen</th>
            <th class="py-2 pr-3"></th>
          </tr>
        </thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
  `;
  return layout("Users", body);
}

export interface NewServiceAccountProps extends AdminPageProps {
  errorMessage?: string;
  prefill?: {
    displayName?: string;
    email?: string;
    roleName?: string;
    btEmail?: string;
  };
}

export function adminNewServiceAccountPage(
  props: NewServiceAccountProps,
): string {
  const error = props.errorMessage
    ? `<div class="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-900">${escape(props.errorMessage)}</div>`
    : "";
  const roleOptions = KNOWN_ROLES.map(
    (r) =>
      `<option value="${escape(r)}"${(props.prefill?.roleName ?? "harness") === r ? " selected" : ""}>${escape(r)}</option>`,
  ).join("");
  const body = `
    ${adminHeader(props.userEmail)}
    <h2 class="text-lg font-semibold mb-3">Provision service account</h2>
    <p class="mb-4 text-sm text-slate-600">
      Service accounts run headless (the harness, future automations). The
      issued <code>mcps_…</code> token will be shown <strong>once</strong>;
      copy it immediately into Doppler.
    </p>
    ${error}
    <form method="POST" action="/admin/service-accounts/new" class="space-y-4">
      <div>
        <label class="block text-sm font-medium" for="display_name">Display name</label>
        <input id="display_name" name="display_name" type="text" required
               value="${escape(props.prefill?.displayName ?? "")}"
               placeholder="harness"
               class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
      </div>
      <div>
        <label class="block text-sm font-medium" for="email">Service identity email</label>
        <input id="email" name="email" type="email" required
               value="${escape(props.prefill?.email ?? "")}"
               placeholder="mcp-harness@mossbuildinganddesign.com"
               class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
        <p class="mt-1 text-xs text-slate-500">
          Used in audit logs. Should be a real (or non-routable) Moss email.
        </p>
      </div>
      <div>
        <label class="block text-sm font-medium" for="role">Role</label>
        <select id="role" name="role" class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
          ${roleOptions}
        </select>
      </div>
      <hr class="my-4">
      <p class="text-sm font-medium">BuildTools credentials for this service identity</p>
      <div>
        <label class="block text-sm font-medium" for="bt_email">BuildTools email</label>
        <input id="bt_email" name="bt_email" type="email" required autocomplete="off"
               value="${escape(props.prefill?.btEmail ?? "")}"
               class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
      </div>
      <div>
        <label class="block text-sm font-medium" for="bt_password">BuildTools password</label>
        <input id="bt_password" name="bt_password" type="password" required autocomplete="off"
               class="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
        <p class="mt-1 text-xs text-slate-500">
          Validated against BuildTools at submit. Encrypted with AES-256-GCM, never echoed back.
        </p>
      </div>
      <button type="submit"
              class="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-white font-medium hover:bg-blue-700">
        Provision service account
      </button>
    </form>
  `;
  return layout("New service account", body);
}

export interface ServiceTokenCreatedProps extends AdminPageProps {
  displayName: string;
  token: string;
  serviceUserId: string;
}

export function adminServiceTokenCreatedPage(
  props: ServiceTokenCreatedProps,
): string {
  const body = `
    ${adminHeader(props.userEmail)}
    <div class="mb-4 rounded-md bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-900">
      Service account <strong>${escape(props.displayName)}</strong> provisioned.
    </div>
    <div class="mb-4 rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
      <strong>Copy this token now.</strong> It will not be shown again.
    </div>
    <pre class="overflow-x-auto rounded-md bg-slate-900 text-slate-100 p-4 text-sm">${escape(props.token)}</pre>
    <p class="mt-4 text-sm text-slate-600">
      Store it in Doppler (e.g., as <code>HARNESS_MCP_TOKEN</code>) and
      restart the consuming service. The service user's row is
      <code>${escape(props.serviceUserId)}</code>; you can revoke this
      token at any time from the <a class="text-blue-600 hover:underline" href="/admin/users">Users page</a>.
    </p>
    <a href="/admin/users" class="mt-4 inline-flex items-center rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100">
      Back to users
    </a>
  `;
  return layout("Service account created", body);
}

export interface AdminAuditRow {
  id: number;
  created_at: string;
  user_id: string | null;
  tool: string;
  project_id: number | null;
  result: string;
  error_message: string | null;
}

export interface AdminAuditPageProps extends AdminPageProps {
  rows: AdminAuditRow[];
  page: number;
  hasNext: boolean;
  filterUserId: string | null;
}

export function adminAuditPage(props: AdminAuditPageProps): string {
  const rows = props.rows
    .map((r) => {
      const ts = r.created_at.replace("T", " ").slice(0, 19);
      const resultBadge =
        r.result === "ok"
          ? "bg-emerald-100 text-emerald-800"
          : r.result === "denied"
            ? "bg-orange-100 text-orange-800"
            : r.result === "rate_limited"
              ? "bg-amber-100 text-amber-800"
              : "bg-red-100 text-red-800";
      const userCell = r.user_id
        ? `<a href="/admin/audit?user_id=${escape(r.user_id)}" class="text-blue-600 hover:underline">${escape(r.user_id.slice(0, 8))}</a>`
        : `<span class="text-slate-400">—</span>`;
      return `
        <tr class="border-t border-slate-100">
          <td class="py-1 pl-3 pr-3 text-xs text-slate-500 align-top whitespace-nowrap">${escape(ts)}</td>
          <td class="py-1 pr-3 text-xs align-top">${userCell}</td>
          <td class="py-1 pr-3 text-sm align-top">${escape(r.tool)}</td>
          <td class="py-1 pr-3 text-xs align-top">${r.project_id ?? ""}</td>
          <td class="py-1 pr-3 align-top"><span class="inline-flex items-center rounded-full ${resultBadge} px-2 py-0.5 text-xs">${escape(r.result)}</span></td>
          <td class="py-1 pr-3 align-top text-xs text-slate-600">${escape(r.error_message ?? "")}</td>
        </tr>
      `;
    })
    .join("");

  const filterChip = props.filterUserId
    ? `<span class="ml-2 inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-900">
         filter: user ${escape(props.filterUserId.slice(0, 8))}…
         <a href="/admin/audit" class="text-blue-600 hover:underline">clear</a>
       </span>`
    : "";
  const nextLink = props.hasNext
    ? `<a href="/admin/audit?page=${props.page + 1}${props.filterUserId ? `&user_id=${escape(props.filterUserId)}` : ""}" class="text-sm text-blue-600 hover:underline">Next page →</a>`
    : "";
  const prevLink =
    props.page > 1
      ? `<a href="/admin/audit?page=${props.page - 1}${props.filterUserId ? `&user_id=${escape(props.filterUserId)}` : ""}" class="text-sm text-blue-600 hover:underline mr-3">← Prev</a>`
      : "";

  const body = `
    ${adminHeader(props.userEmail)}
    <h2 class="text-lg font-semibold mb-3">Audit log — page ${props.page}${filterChip}</h2>
    <div class="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th class="py-2 pl-3 pr-3">When</th>
            <th class="py-2 pr-3">User</th>
            <th class="py-2 pr-3">Tool</th>
            <th class="py-2 pr-3">Project</th>
            <th class="py-2 pr-3">Result</th>
            <th class="py-2 pr-3">Error</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="mt-3 text-right">${prevLink}${nextLink}</div>
  `;
  return layout("Audit", body);
}

export const __test = { escape };
