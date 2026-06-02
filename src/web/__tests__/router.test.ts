import { describe, expect, it } from "vitest";

import { isPublicRoute } from "../router.js";

describe("isPublicRoute", () => {
  it("matches the bare /enroll landing", () => {
    expect(isPublicRoute("/enroll")).toBe(true);
  });

  it("matches every /enroll/* subpath", () => {
    expect(isPublicRoute("/enroll/start")).toBe(true);
    expect(isPublicRoute("/enroll/azure-callback")).toBe(true);
    expect(isPublicRoute("/enroll/save")).toBe(true);
    expect(isPublicRoute("/enroll/status")).toBe(true);
    expect(isPublicRoute("/enroll/logout")).toBe(true);
  });

  it("matches /oauth/* subpaths", () => {
    expect(isPublicRoute("/oauth/register")).toBe(true);
    expect(isPublicRoute("/oauth/authorize")).toBe(true);
    expect(isPublicRoute("/oauth/azure-callback")).toBe(true);
    expect(isPublicRoute("/oauth/token")).toBe(true);
    expect(isPublicRoute("/oauth/revoke")).toBe(true);
  });

  it("matches /.well-known/* discovery endpoints", () => {
    expect(isPublicRoute("/.well-known/oauth-authorization-server")).toBe(true);
  });

  it("rejects MCP transport endpoints", () => {
    expect(isPublicRoute("/sse")).toBe(false);
    expect(isPublicRoute("/messages")).toBe(false);
  });

  it("rejects /enrollment (similar prefix without trailing /)", () => {
    expect(isPublicRoute("/enrollment")).toBe(false);
  });

  it("rejects unrelated paths", () => {
    expect(isPublicRoute("/")).toBe(false);
    expect(isPublicRoute("/admin/users")).toBe(false);
  });
});
