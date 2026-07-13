/**
 * Enrollment / OAuth / admin HTML pages (MOS-328). These are pure string
 * builders; the high-signal property is that every user-controlled value is
 * HTML-escaped (`escape()` runs on every interpolation) so a malicious email,
 * error message, display name, or audit row can't inject markup/script into
 * an admin's browser. Each page is also rendered to confirm it produces a
 * well-formed document and includes its key affordances.
 */
import { describe, it, expect } from "vitest";
import {
  landingPage,
  credentialsFormPage,
  statusPage,
  errorPage,
  adminDashboardPage,
  adminUsersPage,
  adminNewServiceAccountPage,
  adminServiceTokenCreatedPage,
  adminAuditPage,
  __test,
} from "../pages.js";

const XSS = `<script>alert('x')</script>`;
const XSS_ESCAPED = "&lt;script&gt;";

const isDoc = (html: string) => {
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(html).toContain("</html>");
};
// No user-controlled value should ever appear as a live <script>alert tag.
const noRawXss = (html: string) => expect(html).not.toContain("<script>alert");

describe("escape()", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(__test.escape(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
  it("renders null/undefined as empty string, not the words", () => {
    expect(__test.escape(null)).toBe("");
    expect(__test.escape(undefined)).toBe("");
  });
  it("stringifies non-strings", () => {
    expect(__test.escape(42)).toBe("42");
  });
});

describe("landingPage", () => {
  it("renders the Microsoft sign-in entry point", () => {
    const html = landingPage();
    isDoc(html);
    expect(html).toContain("/enroll/start");
    expect(html).toContain("Sign in with Microsoft");
  });
});

describe("credentialsFormPage", () => {
  it("renders the BuildTools credentials form for a signed-in user", () => {
    const html = credentialsFormPage({ userEmail: "u@moss.test", alreadyEnrolled: false });
    isDoc(html);
    expect(html).toContain('action="/enroll/save"');
    expect(html).toContain("u@moss.test");
    expect(html).not.toContain("REPLACE your stored credentials");
  });
  it("shows the re-enroll warning when already enrolled", () => {
    const html = credentialsFormPage({ userEmail: "u@moss.test", alreadyEnrolled: true });
    expect(html).toContain("REPLACE your stored credentials");
  });
  it("escapes a malicious error message and prefill email", () => {
    const html = credentialsFormPage({
      userEmail: XSS,
      alreadyEnrolled: false,
      errorMessage: XSS,
      prefillEmail: XSS,
    });
    noRawXss(html);
    expect(html).toContain(XSS_ESCAPED);
  });
});

describe("statusPage", () => {
  it("renders an enrolled status with roles and BT email", () => {
    const html = statusPage({
      userEmail: "u@moss.test",
      enrolled: true,
      buildtoolsEmail: "bt@moss.test",
      encryptedAt: new Date("2026-01-02T03:04:05Z"),
      roles: ["viewer", "editor"],
    });
    isDoc(html);
    expect(html).toContain("bt@moss.test");
    expect(html).toContain("editor");
  });
  it("renders a not-enrolled status and escapes roles", () => {
    const html = statusPage({ userEmail: "u@moss.test", enrolled: false, roles: [XSS] });
    isDoc(html);
    noRawXss(html);
  });
});

describe("errorPage", () => {
  it("escapes the error message", () => {
    const html = errorPage(XSS);
    isDoc(html);
    noRawXss(html);
    expect(html).toContain(XSS_ESCAPED);
  });
});

describe("admin pages", () => {
  const admin = { userEmail: "admin@moss.test" };

  it("dashboard renders admin nav", () => {
    isDoc(adminDashboardPage(admin));
  });

  it("users page renders rows, role controls, and escapes user fields", () => {
    const html = adminUsersPage({
      ...admin,
      currentUserId: "me",
      csrfToken: "csrf-abc",
      users: [
        {
          id: "u1",
          kind: "human",
          email: XSS,
          displayName: XSS,
          status: "active",
          lastSeenAt: new Date(),
          roles: [{ name: "viewer" }],
        },
        {
          id: "u2",
          kind: "service",
          email: "svc@moss.test",
          displayName: null,
          status: "revoked",
          lastSeenAt: null,
          roles: [],
        },
      ],
    });
    isDoc(html);
    noRawXss(html);
    expect(html).toContain("csrf-abc"); // CSRF token embedded for form POSTs
    expect(html).toContain("svc@moss.test");
  });

  it("new-service-account page renders the form and echoes prefill safely", () => {
    const html = adminNewServiceAccountPage({
      ...admin,
      csrfToken: "csrf-1",
      errorMessage: XSS,
      prefill: { displayName: XSS, email: XSS, roleName: "harness" },
    });
    isDoc(html);
    noRawXss(html);
  });

  it("service-token-created page shows the one-time token", () => {
    const html = adminServiceTokenCreatedPage({
      ...admin,
      displayName: "harness",
      token: "mcps_secret_shown_once",
      serviceUserId: "svc-1",
    });
    isDoc(html);
    expect(html).toContain("mcps_secret_shown_once");
  });

  it("audit page renders rows and escapes tool/error fields", () => {
    const html = adminAuditPage({
      ...admin,
      page: 1,
      hasNext: true,
      filterUserId: null,
      rows: [
        {
          id: 1,
          created_at: "2026-01-01T00:00:00Z",
          user_id: "u1",
          tool: XSS,
          project_id: null,
          result: "ok",
          error_message: XSS,
        },
      ],
    });
    isDoc(html);
    noRawXss(html);
  });
});
