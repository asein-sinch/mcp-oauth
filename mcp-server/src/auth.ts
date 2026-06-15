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
    if (!token) return unauthorized(res, 'missing bearer token');

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
    const subproject = payload.subproject_id;
    if (typeof subproject !== 'string' || !subproject) {
      return unauthorized(res, 'token missing subproject_id claim');
    }
    const creds = getCredentials(subproject);
    if (!creds) {
      return unauthorized(res, `no credentials provisioned for subproject "${subproject}"`);
    }
    req.subprojectId = subproject;
    req.userEmail = typeof payload.sub === 'string' ? payload.sub : undefined;
    req.sinchCreds = creds;
    return next();
  } catch (err) {
    return unauthorized(res, err instanceof Error ? err.message : 'invalid token');
  }
}
