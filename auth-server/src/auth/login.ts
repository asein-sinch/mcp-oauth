import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { verifyCredentials } from '../users.js';
import { putCode } from './store.js';
import type { AuthorizeParams } from './authorize.js';
import { getDynamicClient } from './register.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// views/ is copied next to the compiled auth/ dir at build time (see package.json build script).
const TEMPLATE = readFileSync(join(__dirname, '..', 'views', 'login.html'), 'utf8');

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderLoginPage(opts: {
  params?: AuthorizeParams;
  error?: string;
  email?: string;
}): string {
  const errorHtml = opts.error ? `<div class="error">${esc(opts.error)}</div>` : '';

  let formHtml = '';
  if (opts.params) {
    const p = opts.params;
    const hidden = (name: string, value: string) =>
      `<input type="hidden" name="${name}" value="${esc(value)}" />`;
    formHtml = `
      <form method="post" action="/login">
        ${hidden('client_id', p.clientId)}
        ${hidden('redirect_uri', p.redirectUri)}
        ${hidden('scope', p.scope)}
        ${hidden('state', p.state)}
        ${hidden('code_challenge', p.codeChallenge)}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value="${esc(opts.email ?? '')}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in &amp; Authorize</button>
      </form>`;
  }

  return TEMPLATE.replace('{{ERROR}}', errorHtml).replace('{{FORM}}', formHtml);
}

/** Re-validate the OAuth params posted from the login form (do not trust hidden fields blindly). */
function paramsFromBody(body: Record<string, unknown>): AuthorizeParams | null {
  const clientId = String(body.client_id ?? '');
  const redirectUri = String(body.redirect_uri ?? '');
  const codeChallenge = String(body.code_challenge ?? '');
  const client = config.clients[clientId] ?? getDynamicClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri) || !codeChallenge) return null;
  return {
    clientId,
    redirectUri,
    scope: String(body.scope ?? ''),
    state: String(body.state ?? ''),
    codeChallenge,
  };
}

export async function handleLogin(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const params = paramsFromBody(body);
  if (!params) {
    res.status(400).type('html').send(renderLoginPage({ error: 'Invalid or expired authorization request' }));
    return;
  }

  const email = String(body.email ?? '');
  const password = String(body.password ?? '');
  const user = await verifyCredentials(email, password);
  if (!user) {
    res
      .status(401)
      .type('html')
      .send(renderLoginPage({ params, error: 'Invalid email or password', email }));
    return;
  }

  // Mark the session as signed in (optional, enables SSO-style reuse later).
  if (req.session) req.session.email = user.email;

  // Issue a single-use authorization code bound to this user + PKCE challenge.
  const code = nanoid(48);
  putCode(code, {
    email: user.email,
    subprojectId: user.subprojectId,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    codeChallenge: params.codeChallenge,
  });

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', params.state);
  res.redirect(302, redirect.toString());
}
