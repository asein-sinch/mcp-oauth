import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from './config.js';
import { getCredentials } from './vault.js';
import type { SinchCredentials } from './config.js';

/**
 * Resolves the per-request identity + Sinch credentials according to AUTH_MODE:
 *  - jwt          : verify a Bearer JWT against the auth server's JWKS, read subproject_id,
 *                   and look up its credentials in the vault.
 *  - static-token : Bearer base64("projectId:accessKey:accessSecret") — credentials travel in
 *                   the token; no auth server, no vault.
 *  - none         : no client auth; a single hardcoded credential set is used for every request.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      subprojectId?: string;
      userEmail?: string;
      sinchCreds?: SinchCredentials;
    }
  }
}

// JWKS is created lazily and only in jwt mode (other modes need no auth server).
let jwks: JWTVerifyGetKey | undefined;
function getJwks(): JWTVerifyGetKey {
  if (!jwks) jwks = createRemoteJWKSet(new URL(config.jwksUrl!));
  return jwks;
}

function unauthorized(res: Response, description: string): void {
  res
    .set('WWW-Authenticate', `Bearer error="invalid_token", error_description="${description}"`)
    .status(401)
    .json({ error: 'unauthorized', error_description: description });
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (config.authMode === 'none') {
      req.subprojectId = config.staticProjectId;
      req.sinchCreds = { accessKey: config.staticAccessKey!, accessSecret: config.staticAccessSecret! };
      return next();
    }

    const token = bearer(req);
    if (!token) {
      if (config.authMode === 'jwt') {
        // First unauthenticated request: advertise resource_metadata so MCP clients can
        // auto-discover the auth server (RFC 9728 + MCP OAuth spec).
        const base = `${req.protocol}://${req.get('host')}`;
        res
          .set('WWW-Authenticate',
               `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
          .status(401)
          .json({ error: 'unauthorized', error_description: 'missing bearer token' });
        return;
      }
      return unauthorized(res, 'missing bearer token');
    }

    if (config.authMode === 'static-token') {
      // base64("projectId:accessKey:accessSecret") — split on the first two colons so the
      // secret may itself contain ':'.
      let decoded: string;
      try {
        decoded = Buffer.from(token, 'base64').toString('utf8');
      } catch {
        return unauthorized(res, 'token is not valid base64');
      }
      const i1 = decoded.indexOf(':');
      const i2 = i1 >= 0 ? decoded.indexOf(':', i1 + 1) : -1;
      if (i1 < 1 || i2 < 0) {
        return unauthorized(res, 'token must be base64 of "projectId:accessKey:accessSecret"');
      }
      const projectId = decoded.slice(0, i1);
      const accessKey = decoded.slice(i1 + 1, i2);
      const accessSecret = decoded.slice(i2 + 1);
      if (!projectId || !accessKey || !accessSecret) {
        return unauthorized(res, 'token must include projectId, accessKey and accessSecret');
      }
      req.subprojectId = projectId;
      req.sinchCreds = { accessKey, accessSecret };
      return next();
    }

    // jwt mode
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: config.expectedIssuer,
      audience: config.expectedAudience,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    req.userEmail = typeof payload.sub === 'string' ? payload.sub : undefined;

    if (config.credentialSource === 'exchange') {
      // Dashboard mode: exchange the validated client token for a short-lived Sinch M2M token.
      // The token carries no secrets — only an opaque cred_ref the auth server resolves.
      const exchanged = await exchangeForSinchToken(token);
      if (!exchanged) return unauthorized(res, 'token exchange failed');
      const projectId =
        exchanged.projectId ?? (typeof payload.project_id === 'string' ? payload.project_id : undefined);
      if (!projectId) return unauthorized(res, 'token exchange returned no project');
      req.subprojectId = projectId;
      req.sinchCreds = { accessKey: '', accessSecret: '', bearerToken: exchanged.accessToken };
      return next();
    }

    // vault mode: subproject_id claim -> Sinch access key/secret from the env vault.
    const subproject = payload.subproject_id;
    if (typeof subproject !== 'string' || !subproject) {
      return unauthorized(res, 'token missing subproject_id claim');
    }
    const creds = getCredentials(subproject);
    if (!creds) {
      return unauthorized(res, `no credentials provisioned for subproject "${subproject}"`);
    }
    req.subprojectId = subproject;
    req.sinchCreds = creds;
    return next();
  } catch (err) {
    return unauthorized(res, err instanceof Error ? err.message : 'invalid token');
  }
}

/**
 * Back-channel RFC 8693 token exchange against the auth server. Presents the user's validated
 * client token as `subject_token` and this server's confidential-client credentials, and receives
 * a short-lived Sinch M2M access token for the user's selected project.
 */
async function exchangeForSinchToken(
  subjectToken: string,
): Promise<{ accessToken: string; projectId?: string } | null> {
  const basic = Buffer.from(`${config.backchannelClientId}:${config.backchannelClientSecret}`).toString('base64');
  const res = await fetch(config.tokenExchangeUrl!, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; project_id?: string }
    | null;
  if (!json?.access_token) return null;
  return { accessToken: json.access_token, projectId: json.project_id };
}
