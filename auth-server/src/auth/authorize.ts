import type { Request, Response } from 'express';
import { config } from '../config.js';
import { renderLoginPage } from './login.js';
import { getDynamicClient } from './register.js';

/** Fields of an OAuth authorization-code request that we carry through the login form. */
export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

/**
 * Validates the incoming authorization request. Returns parsed params on success,
 * or an { error } describing why. Per OAuth, errors involving an untrusted client or
 * redirect_uri must NOT be redirected back — we render an error page instead.
 */
export function validateAuthorizeRequest(
  q: Record<string, unknown>,
): { ok: true; params: AuthorizeParams } | { ok: false; error: string; safeToRedirect: boolean } {
  const clientId = str(q.client_id);
  const redirectUri = str(q.redirect_uri);
  const client = clientId ? (config.clients[clientId] ?? getDynamicClient(clientId)) : undefined;

  if (!clientId || !client) return { ok: false, error: 'Unknown client_id', safeToRedirect: false };
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, error: 'redirect_uri is not registered for this client', safeToRedirect: false };
  }
  // From here, errors could in principle be redirected, but for the demo we render them.
  if (str(q.response_type) !== 'code') {
    return { ok: false, error: 'Only response_type=code is supported', safeToRedirect: true };
  }
  const codeChallenge = str(q.code_challenge);
  if (!codeChallenge || str(q.code_challenge_method) !== 'S256') {
    return { ok: false, error: 'PKCE with code_challenge_method=S256 is required', safeToRedirect: true };
  }

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      scope: str(q.scope) ?? '',
      state: str(q.state) ?? '',
      codeChallenge,
    },
  };
}

export function handleAuthorize(req: Request, res: Response): void {
  const result = validateAuthorizeRequest(req.query as Record<string, unknown>);
  if (!result.ok) {
    res.status(400).type('html').send(renderLoginPage({ error: result.error }));
    return;
  }
  // Render the login + consent page, carrying the OAuth params as hidden fields.
  res.type('html').send(renderLoginPage({ params: result.params }));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
