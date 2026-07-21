import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { getPrivateKey, getVerificationKey, SIGNING_ALG } from '../keys.js';
import { consumeCode } from './store.js';
import { pollDeviceToken } from './deviceStore.js';
import { verifyPkceS256 } from './pkce.js';
import { getDynamicClient } from './register.js';
import { getCred, updateCred } from '../credStore.js';
import { ensureFreshAccessKey, clientCredentialsToken, refreshCcpToken } from '../dashboard.js';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

// ── User token cache ───────────────────────────────────────────────────
// Keyed by client_id. Survives context_id changes within the same GE session.
// In a real multi-user system, key by the authenticated GE user identity instead.
const userTokenCache = new Map<string, { token: string; expiresAt: number }>();

function cacheToken(clientId: string, token: string, ttlSeconds: number): void {
  userTokenCache.set(clientId, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/** GET /token/cached?client_id=xxx — return a valid cached token if available. */
export function handleTokenCached(req: Request, res: Response): void {
  const clientId = String(req.query.client_id ?? '').trim();
  const entry = userTokenCache.get(clientId);
  if (!entry || Date.now() > entry.expiresAt) {
    userTokenCache.delete(clientId);
    res.status(404).json({ error: 'no_cached_token' });
    return;
  }
  res.json({ access_token: entry.token, token_type: 'Bearer', cached: true });
}

function tokenError(res: Response, status: number, error: string, description?: string): void {
  res.status(status).json({ error, error_description: description });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract client credentials from HTTP Basic auth header or from the form body. */
function clientCredentials(req: Request): { id: string; secret: string } | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  }
  const body = req.body as Record<string, unknown>;
  if (body.client_id) return { id: String(body.client_id), secret: String(body.client_secret ?? '') };
  return null;
}

export async function handleToken(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const grantType = String(body.grant_type ?? '');

  // ── Device Authorization Grant (RFC 8628) ────────────────────────────────
  if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
    const deviceCode = String(body.device_code ?? '');
    const clientId = String(body.client_id ?? '');

    if (!deviceCode || !clientId) {
      return tokenError(res, 400, 'invalid_request', 'device_code and client_id are required');
    }

    const result = pollDeviceToken(deviceCode);
    if (result === 'expired') {
      return tokenError(res, 400, 'expired_token', 'The device code has expired');
    }
    if (result === null) {
      return tokenError(res, 400, 'authorization_pending', 'The user has not yet authorized the device');
    }

    // User authorized — mint the same JWT as the auth-code flow.
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ subproject_id: result.subprojectId, scope: result.scope })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: config.keyId, typ: 'JWT' })
      .setIssuer(config.issuerUrl)
      .setSubject(result.email!)
      .setAudience(config.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + config.accessTokenTtl)
      .sign(getPrivateKey());

    // Cache the token so subsequent A2A turns (with a new context_id) can
    // retrieve it without re-doing the full device flow.
    cacheToken(clientId, accessToken, config.accessTokenTtl);

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl,
      scope: result.scope,
    });
    return;
  }

  // ── Token Exchange (RFC 8693) — MCP server back-channel ───────────────────
  // The MCP server presents the validated client access token (subject_token) and authenticates
  // as a confidential client; we resolve its cred_ref to the user's stored dashboard JWT, mint a
  // Sinch access key for the chosen project, and return a short-lived Sinch M2M token. Sensitive
  // material never leaves this server.
  if (grantType === TOKEN_EXCHANGE_GRANT) {
    return handleTokenExchange(req, res);
  }

  // ── Authorization Code Grant ──────────────────────────────────────────────
  if (grantType !== 'authorization_code') {
    return tokenError(
      res,
      400,
      'unsupported_grant_type',
      'Only authorization_code, device_code and token-exchange are supported',
    );
  }

  // 1. Authenticate the client.
  const creds = clientCredentials(req);
  if (!creds) return tokenError(res, 401, 'invalid_client', 'Client authentication failed');

  const staticClient = config.clients[creds.id];
  if (staticClient) {
    // Confidential static client — must present the registered secret.
    if (!safeEqual(creds.secret, staticClient.clientSecret)) {
      return tokenError(res, 401, 'invalid_client', 'Client authentication failed');
    }
  } else if (!getDynamicClient(creds.id)) {
    // Unknown client.
    return tokenError(res, 401, 'invalid_client', 'Client authentication failed');
  }
  // Dynamic public clients: skip secret check — PKCE provides the token-exchange security.

  // 2. Redeem the authorization code (single use).
  const code = String(body.code ?? '');
  const record = consumeCode(code);
  if (!record) return tokenError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired');

  if (record.clientId !== creds.id) {
    return tokenError(res, 400, 'invalid_grant', 'Code was issued to a different client');
  }
  if (record.redirectUri !== String(body.redirect_uri ?? '')) {
    return tokenError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
  }

  // 3. Verify PKCE.
  const verifier = String(body.code_verifier ?? '');
  if (!verifier || !verifyPkceS256(verifier, record.codeChallenge)) {
    return tokenError(res, 400, 'invalid_grant', 'PKCE verification failed');
  }

  // 4. scripted mode: the access key was already minted at project-selection time — return the
  //    raw static token as-is. No JWT signing, no back-channel exchange for this mode.
  if (record.staticToken) {
    res.json({
      access_token: record.staticToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtl,
      scope: record.scope,
    });
    return;
  }

  // Mint the signed JWT access token.
  //    dashboard mode: identity-only claims + an opaque cred_ref (NO secrets in the token).
  //    local mode    : the user's fixed subproject_id.
  const claims: Record<string, unknown> = record.credRef
    ? { account_id: record.accountId, project_id: record.projectId, cred_ref: record.credRef, scope: record.scope }
    : { subproject_id: record.subprojectId, scope: record.scope };

  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: SIGNING_ALG, kid: config.keyId, typ: 'JWT' })
    .setIssuer(config.issuerUrl)
    .setSubject(record.email)
    .setAudience(config.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + config.accessTokenTtl)
    .sign(getPrivateKey());

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.accessTokenTtl,
    scope: record.scope,
  });
}

/**
 * RFC 8693 token exchange. Converts the user's MCP access token (which carries only a cred_ref)
 * into a short-lived Sinch M2M token for the selected project. This is the exact API shape we
 * want the dashboard team to implement natively (personal JWT + projectId -> M2M token); here we
 * fake the internals with on-demand access-key creation + client_credentials.
 */
async function handleTokenExchange(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;

  // 1. Authenticate the caller as a confidential client (dynamic/public clients not allowed here).
  const creds = clientCredentials(req);
  const client = creds ? config.clients[creds.id] : undefined;
  if (!creds || !client || !safeEqual(creds.secret, client.clientSecret)) {
    return tokenError(res, 401, 'invalid_client', 'Client authentication failed');
  }

  // 2. Verify the subject_token is an access token WE issued (signature, iss, aud).
  const subjectToken = String(body.subject_token ?? '');
  if (!subjectToken) {
    return tokenError(res, 400, 'invalid_request', 'subject_token is required');
  }
  let credRef: string | undefined;
  try {
    const { payload } = await jwtVerify(subjectToken, getVerificationKey(), {
      issuer: config.issuerUrl,
      audience: config.audience,
      algorithms: [SIGNING_ALG],
      clockTolerance: 5,
    });
    credRef = typeof payload.cred_ref === 'string' ? payload.cred_ref : undefined;
  } catch {
    return tokenError(res, 400, 'invalid_grant', 'subject_token is invalid or expired');
  }
  if (!credRef) {
    return tokenError(res, 400, 'invalid_grant', 'subject_token has no cred_ref (not a dashboard-mode token)');
  }

  // 3. Resolve the cred_ref to the stored dashboard JWT + project, then mint a Sinch M2M token.
  const cred = getCred(credRef);
  if (!cred) {
    return tokenError(res, 400, 'invalid_grant', 'credential reference expired — re-authenticate');
  }

  try {
    const now = Date.now();
    if (cred.cachedToken && now < cred.cachedToken.expiresAt) {
      res.json(exchangeResponse(cred.cachedToken.token, cred.cachedToken.expiresAt, cred.projectId));
      return;
    }
    // Reuse a previously minted access key if we have one cached; otherwise create a fresh one.
    if (!cred.accountId) {
      return tokenError(res, 400, 'invalid_grant', 'credential reference is missing the account context');
    }
    // The cookie can always mint a guaranteed-fresh CCP JWT, so prefer that over the JWT stored
    // at login time (which may be hours old by the time the first exchange happens).
    const dashboardJwt = cred.dashboardCookie
      ? await refreshCcpToken(cred.dashboardCookie)
      : cred.dashboardJwt;
    const key =
      cred.cachedKey ??
      (await ensureFreshAccessKey(
        { token: dashboardJwt, cookie: cred.dashboardCookie },
        cred.accountId,
        cred.projectId,
      ));
    const { accessToken, expiresIn } = await clientCredentialsToken(key);
    const expiresAt = now + Math.max(0, expiresIn - 30) * 1000;
    updateCred(credRef, { cachedKey: key, cachedToken: { token: accessToken, expiresAt } });
    res.json(exchangeResponse(accessToken, expiresAt, cred.projectId));
  } catch {
    return tokenError(res, 502, 'exchange_failed', 'Could not mint Sinch credentials for the project');
  }
}

function exchangeResponse(token: string, expiresAt: number, projectId: string) {
  return {
    access_token: token,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    project_id: projectId,
  };
}
