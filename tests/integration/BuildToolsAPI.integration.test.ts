/**
 * Integration tests for BuildToolsAPI — require a live BuildTools instance.
 *
 * These tests are SKIPPED by default. To run them, set the following env vars:
 *   BUILDTOOLS_LIVE=1
 *   BUILDTOOLS_TENANT=<your-tenant>
 *   BUILDTOOLS_USERNAME=<your-username>
 *   BUILDTOOLS_PASSWORD=<your-password>
 *
 * Run with:
 *   BUILDTOOLS_LIVE=1 BUILDTOOLS_TENANT=moss BUILDTOOLS_USERNAME=... \
 *   BUILDTOOLS_PASSWORD=... npx vitest run tests/integration/
 */

import { describe, it, expect } from "vitest";
import { BuildToolsAPI } from "../../src/client/BuildToolsAPI.js";

const LIVE = Boolean(process.env.BUILDTOOLS_LIVE);

describe.skipIf(!LIVE)("BuildToolsAPI — live integration", () => {
  const opts = {
    tenant: process.env.BUILDTOOLS_TENANT ?? "",
    username: process.env.BUILDTOOLS_USERNAME ?? "",
    password: process.env.BUILDTOOLS_PASSWORD ?? "",
  };

  it("authenticates against the live API", async () => {
    const api = new BuildToolsAPI(opts);
    await api.authenticate();
    expect(api.isAuthenticated()).toBe(true);
  });

  it("lists projects from the live API", async () => {
    const api = new BuildToolsAPI(opts);
    await api.authenticate();
    const projects = await api.listProjects();
    expect(Array.isArray(projects)).toBe(true);
  });
});
