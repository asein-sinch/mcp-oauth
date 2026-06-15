import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { SignJWT } from 'jose';
import { config } from '../config.js';
import { getPrivateKey, SIGNING_ALG } from '../keys.js';
import { consumeCode } from './store.js';
import { verifyPkceS256 } from './pkce.js';

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

  if (String(body.grant_type ?? '') !== 'authorization_code') {
    return tokenError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
  }

  // 1. Authenticate the client.
  const creds = clientCredentials(req);
  const client = creds ? config.clients[creds.id] : undefined;
  if (!creds || !client || !safeEqual(creds.secret, client.clientSecret)) {
    return tokenError(res, 401, 'invalid_client', 'Client authentication failed');
  }

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

  // 4. Mint the signed JWT access token carrying the subproject_id claim.
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({ subproject_id: record.subprojectId, scope: record.scope })
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
