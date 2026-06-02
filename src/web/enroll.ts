/**
 * Enrollment routes (MOS-328 Phase 4).
 *
 * Browser-side flow for a Moss employee to:
 *   1. Sign in with Microsoft Entra ID (one-time per session)
 *   2. Submit their BuildTools email + password (validated by a real
 *      BuildTools login attempt)
 *   3. Have those credentials encrypted + stored in Supabase
 *
 * Routes:
 *   GET  /enroll                    landing page (or status if signed in)
 *   GET  /enroll/start              kicks off Azure auth-code flow
 *   GET  /enroll/azure-callback     Azure returns here, sets session cookie
 *   POST /enroll/save               accepts the BuildTools credentials form
 *   GET  /enroll/status             "you are/aren't enrolled" page
 *   GET  /enroll/logout             clears the session cookie
 *
 * Everything in this module assumes the Express router is mounted on
 * the public HTTPS origin (buildtools-mcp.mossbuildinganddesign.com).
 * Cookies are Secure + SameSite=Lax — the Azure callback needs to be
 * the entry point for the cookie to attach, hence Lax not Strict.
 */

import express, { type Request, type Response, type Router } from "express";
import type { Configuration } from "openid-client";

import { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import {
  assertAllowedDomain,
  buildAuthorizationUrl,
  exchangeCode,
  type AzureConfig,
} from "../auth/azure.js";
import {
  upsertServiceCredentials,
  getServiceCredentials,
  hasCredentialsFor,
} from "../auth/credentials.js";
import type { Db } from "../auth/db.js";
import {
  buildClearCookieHeader,
  buildCookieHeader,
  openState,
  parseCookieHeader,
  sealState,
  signCookie,
  verifyCookie,
} from "../auth/session.js";
import { upsertHumanUser, getUserWithRoles } from "../auth/users.js";

const SESSION_COOKIE = "mcp_enroll_session";
const SESSION_TTL_SECONDS = 30 * 60;

interface EnrollSession {
  userId: string;
  email: string;
}

interface AzureStateForEnroll {
  kind: "enroll";
  codeVerifier: string;
  nonce: string;
}

export interface EnrollDeps {
  db: Db;
  encryptionKey: Buffer;
  azure: AzureConfig;
  azureDiscovery: Configuration;
  publicOrigin: string; // e.g. https://buildtools-mcp.mossbuildinganddesign.com
}

function readSession(req: Request, key: Buffer): EnrollSession | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifyCookie<EnrollSession>(token, key);
}

function setSession(res: Response, key: Buffer, session: EnrollSession): void {
  const token = signCookie(session, key, { ttlSeconds: SESSION_TTL_SECONDS });
  res.setHeader(
    "Set-Cookie",
    buildCookieHeader({
      name: SESSION_COOKIE,
      value: token,
      maxAge: SESSION_TTL_SECONDS,
      sameSite: "lax",
    }),
  );
}

function clearSession(res: Response): void {
  res.setHeader("Set-Cookie", buildClearCookieHeader(SESSION_COOKIE));
}

export function mountEnrollRoutes(router: Router, deps: EnrollDeps): void {
  // ----- Landing / status ----------------------------------------------------

  router.get("/enroll", async (req, res) => {
    const session = readSession(req, deps.encryptionKey);
    if (!session) {
      // Not signed in → render landing page (Sign-in-with-Microsoft button).
      const { landingPage } = await import("./pages.js");
      res.type("html").send(landingPage());
      return;
    }
    // Signed in → render credentials form.
    const { credentialsFormPage } = await import("./pages.js");
    const enrolled = await hasCredentialsFor(deps.db, session.userId, "buildtools");
    const existing = enrolled
      ? await getServiceCredentials(
          deps.db,
          session.userId,
          "buildtools",
          deps.encryptionKey,
        )
      : null;
    res.type("html").send(
      credentialsFormPage({
        userEmail: session.email,
        alreadyEnrolled: enrolled,
        prefillEmail: existing?.email,
      }),
    );
  });

  router.get("/enroll/status", async (req, res) => {
    const session = readSession(req, deps.encryptionKey);
    if (!session) {
      res.redirect("/enroll");
      return;
    }
    const user = await getUserWithRoles(deps.db, session.userId);
    if (!user) {
      clearSession(res);
      res.redirect("/enroll");
      return;
    }
    const { statusPage } = await import("./pages.js");
    const { data, error } = await deps.db
      .from("mcp_service_credentials")
      .select("encrypted_at")
      .eq("user_id", user.id)
      .eq("service", "buildtools")
      .maybeSingle();
    if (error) {
      const { errorPage } = await import("./pages.js");
      res.status(500).type("html").send(errorPage(`Lookup failed: ${error.message}`));
      return;
    }
    const enrolled = data !== null;
    const existing = enrolled
      ? await getServiceCredentials(
          deps.db,
          session.userId,
          "buildtools",
          deps.encryptionKey,
        )
      : null;
    res.type("html").send(
      statusPage({
        userEmail: user.email,
        enrolled,
        buildtoolsEmail: existing?.email,
        encryptedAt: data ? new Date((data as { encrypted_at: string }).encrypted_at) : undefined,
        roles: user.roles.map((r) => r.name),
      }),
    );
  });

  // ----- Azure sign-in --------------------------------------------------------

  router.get("/enroll/start", async (_req, res) => {
    // Generate PKCE + nonce up front, then seal them into a single state
    // token that round-trips through Azure. Azure echoes `state` verbatim;
    // we decrypt on the callback to recover the verifier + nonce.
    const { randomPKCECodeVerifier, calculatePKCECodeChallenge, randomNonce } =
      await import("openid-client");
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const nonce = randomNonce();
    const sealedState = sealState<AzureStateForEnroll>(
      { kind: "enroll", codeVerifier, nonce },
      deps.encryptionKey,
    );

    const result = await buildAuthorizationUrl(deps.azureDiscovery, {
      redirectUri: `${deps.publicOrigin}/enroll/azure-callback`,
      state: sealedState,
      codeVerifier,
      nonce,
    });
    // `buildAuthorizationUrl` recomputes the challenge from the verifier
    // we passed — confirm equal (sanity, not security).
    if (result.codeChallenge !== codeChallenge) {
      throw new Error("PKCE challenge mismatch (build vs derive)");
    }
    res.redirect(result.url);
  });

  router.get("/enroll/azure-callback", async (req, res) => {
    const stateParam =
      typeof req.query.state === "string" ? req.query.state : null;
    if (!stateParam) {
      const { errorPage } = await import("./pages.js");
      res.status(400).type("html").send(errorPage("Missing state parameter."));
      return;
    }
    const state = openState<AzureStateForEnroll>(stateParam, deps.encryptionKey);
    if (!state || state.kind !== "enroll") {
      const { errorPage } = await import("./pages.js");
      res.status(400).type("html").send(errorPage("Invalid or expired state."));
      return;
    }
    try {
      const currentUrl = new URL(
        `${deps.publicOrigin}${req.originalUrl}`,
      );
      const identity = await exchangeCode(deps.azureDiscovery, {
        currentUrl,
        expectedState: stateParam,
        codeVerifier: state.codeVerifier,
        expectedNonce: state.nonce,
      });
      assertAllowedDomain(identity.email, deps.azure.allowedDomain);
      const user = await upsertHumanUser(deps.db, {
        azureSub: identity.sub,
        email: identity.email,
        displayName: identity.name ?? null,
      });
      setSession(res, deps.encryptionKey, { userId: user.id, email: user.email });
      res.redirect("/enroll");
    } catch (err) {
      const { errorPage } = await import("./pages.js");
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(400)
        .type("html")
        .send(errorPage(`Sign-in failed: ${msg}`));
    }
  });

  // ----- Save BuildTools credentials ------------------------------------------

  router.post("/enroll/save", express.urlencoded({ extended: false }), async (req, res) => {
    const session = readSession(req, deps.encryptionKey);
    if (!session) {
      res.redirect("/enroll");
      return;
    }
    const btEmail = typeof req.body?.bt_email === "string" ? req.body.bt_email.trim() : "";
    const btPassword =
      typeof req.body?.bt_password === "string" ? req.body.bt_password : "";
    if (!btEmail || !btPassword) {
      const { credentialsFormPage } = await import("./pages.js");
      const enrolled = await hasCredentialsFor(deps.db, session.userId, "buildtools");
      res.status(400).type("html").send(
        credentialsFormPage({
          userEmail: session.email,
          alreadyEnrolled: enrolled,
          errorMessage: "Email and password are required.",
          prefillEmail: btEmail,
        }),
      );
      return;
    }

    // Validate by attempting a live BuildTools login. If it fails we
    // refuse to store anything — bad credentials should fail loud, not
    // silently sit in the table waiting for the first tool call to 401.
    const api = new BuildToolsAPI({
      tenant: process.env.BUILDTOOLS_TENANT ?? "moss",
      baseUrl: process.env.BUILDTOOLS_BASE_URL,
    });
    try {
      await api.authenticate(btEmail, btPassword);
    } catch (err) {
      const { credentialsFormPage } = await import("./pages.js");
      const enrolled = await hasCredentialsFor(deps.db, session.userId, "buildtools");
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).type("html").send(
        credentialsFormPage({
          userEmail: session.email,
          alreadyEnrolled: enrolled,
          errorMessage: `BuildTools login failed: ${msg}`,
          prefillEmail: btEmail,
        }),
      );
      return;
    }

    await upsertServiceCredentials(
      deps.db,
      session.userId,
      "buildtools",
      { email: btEmail, password: btPassword },
      deps.encryptionKey,
    );
    res.redirect("/enroll/status");
  });

  // ----- Logout ---------------------------------------------------------------

  router.get("/enroll/logout", (_req, res) => {
    clearSession(res);
    res.redirect("/enroll");
  });
}
