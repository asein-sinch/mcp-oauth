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
import { getSession, updateSession, deleteSession, type LoginSession } from './loginSession.js';
import { putCred } from '../credStore.js';
import {
  inspectDashboardToken,
  listAccounts,
  listProjects,
  type Account,
  type Project,
} from '../dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// views/ is copied next to the compiled auth/ dir at build time (see package.json build script).
const TEMPLATE = readFileSync(join(__dirname, '..', 'views', 'login.html'), 'utf8');

const DEFAULT_SUBTITLE =
  'Sign in to authorize <strong>Gemini Enterprise</strong> to access your Sinch account.';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fill the shared card shell with a subtitle (trusted HTML), an optional error, and a form. */
function renderShell(opts: { subtitle?: string; error?: string; form: string }): string {
  const errorHtml = opts.error ? `<div class="error">${esc(opts.error)}</div>` : '';
  return TEMPLATE
    .replace('{{SUBTITLE}}', opts.subtitle ?? DEFAULT_SUBTITLE)
    .replace('{{ERROR}}', errorHtml)
    .replace('{{FORM}}', opts.form);
}

// ── local mode login form (bcrypt USERS) ─────────────────────────────────────
export function renderLoginPage(opts: {
  params?: AuthorizeParams; // local mode: OAuth params carried as hidden fields
  error?: string;
  email?: string;
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${esc(value)}" />`;
  const hiddenFields = opts.params
    ? [
        hidden('client_id', opts.params.clientId),
        hidden('redirect_uri', opts.params.redirectUri),
        hidden('scope', opts.params.scope),
        hidden('state', opts.params.state),
        hidden('code_challenge', opts.params.codeChallenge),
      ].join('\n        ')
    : '';

  const form = `
      <form method="post" action="/login">
        ${hiddenFields}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value="${esc(opts.email ?? '')}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in &amp; Authorize</button>
      </form>`;
  return renderShell({ error: opts.error, form });
}

// ── dashboard mode: paste-the-token + account/project selection ──────────────
export function renderTokenPage(opts: { error?: string }): string {
  const ta =
    'width:100%;padding:11px 12px;border-radius:9px;border:1px solid #2b3144;background:#0e1117;' +
    'color:#e7e9ee;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;';
  const form = `
      <form method="post" action="/login">
        <label for="dashboard_token">Dashboard token</label>
        <textarea id="dashboard_token" name="dashboard_token" rows="5" required autofocus style="${ta}"></textarea>
        <label for="dashboard_cookie">Dashboard cookie <span style="color:#6b7385">(if required)</span></label>
        <textarea id="dashboard_cookie" name="dashboard_cookie" rows="3" style="${ta}"></textarea>
        <button type="submit">Continue</button>
      </form>`;
  return renderShell({
    subtitle:
      'Paste your Sinch dashboard bearer token (Dashboard → DevTools → Network → any ' +
      '<code>graphql</code> request → the <code>Authorization: Bearer</code> value), and the ' +
      '<code>Cookie</code> header from that same request if calls require it.',
    error: opts.error,
    form,
  });
}

function renderSelectPage(opts: {
  action: string;
  field: string;
  label: string;
  subtitle: string;
  options: { id: string; name: string }[];
  error?: string;
}): string {
  const optionsHtml = opts.options
    .map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`)
    .join('\n          ');
  const form = `
      <form method="post" action="${opts.action}">
        <label for="${opts.field}">${esc(opts.label)}</label>
        <select id="${opts.field}" name="${opts.field}" required>
          ${optionsHtml}
        </select>
        <button type="submit">Continue</button>
      </form>`;
  return renderShell({ subtitle: opts.subtitle, error: opts.error, form });
}

// ── local mode (bcrypt USERS) ───────────────────────────────────────────────

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

async function handleLocalLogin(req: Request, res: Response): Promise<void> {
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
    res.status(401).type('html').send(renderLoginPage({ params, error: 'Invalid email or password', email }));
    return;
  }

  if (req.session) req.session.email = user.email;

  const code = nanoid(48);
  putCode(code, {
    email: user.email,
    subprojectId: user.subprojectId,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    codeChallenge: params.codeChallenge,
  });

  redirectWithCode(res, params.redirectUri, code, params.state);
}

// ── dashboard mode ───────────────────────────────────────────────────────────
function sid(req: Request): string | undefined {
  return req.session?.loginSid as string | undefined;
}

const EXPIRED_MSG = 'Your session expired. Please restart from Gemini Enterprise.';

async function handleDashboardLogin(req: Request, res: Response): Promise<void> {
  const id = sid(req);
  const session = getSession(id);
  if (!id || !session) {
    res.status(400).type('html').send(renderTokenPage({ error: EXPIRED_MSG }));
    return;
  }

  const body = req.body as Record<string, unknown>;
  const token = String(body.dashboard_token ?? '').trim();
  const cookie = String(body.dashboard_cookie ?? '').trim() || undefined;
  const inspected = inspectDashboardToken(token);
  if (!inspected.valid) {
    res.status(400).type('html').send(renderTokenPage({ error: inspected.reason ?? 'Invalid token.' }));
    return;
  }

  updateSession(id, { stage: 'account', dashboardJwt: token, dashboardCookie: cookie, email: inspected.sub });
  try {
    await proceedToAccountStep(id, res);
  } catch {
    res.status(401).type('html').send(renderTokenPage({ error: 'That token was rejected by the dashboard. Paste a fresh one.' }));
  }
}

/** Fetch accounts; auto-skip if exactly one, otherwise render the picker. */
async function proceedToAccountStep(id: string, res: Response): Promise<void> {
  const session = getSession(id)!;
  const accounts = await listAccounts({ token: session.dashboardJwt!, cookie: session.dashboardCookie });
  if (accounts.length === 0) {
    res.status(400).type('html').send(renderTokenPage({ error: 'No Sinch accounts are visible with this token.' }));
    return;
  }
  updateSession(id, { accounts });
  if (accounts.length === 1) {
    updateSession(id, { accountId: accounts[0].id, stage: 'project' });
    await proceedToProjectStep(id, res);
    return;
  }
  res.type('html').send(
    renderSelectPage({
      action: '/select-account',
      field: 'account_id',
      label: 'Account',
      subtitle: 'Choose the Sinch account to authorize.',
      options: accounts.map((a: Account) => ({ id: a.id, name: a.name })),
    }),
  );
}

export async function handleSelectAccount(req: Request, res: Response): Promise<void> {
  const id = sid(req);
  const session = getSession(id);
  if (!id || !session || !session.accounts) {
    res.status(400).type('html').send(renderTokenPage({ error: EXPIRED_MSG }));
    return;
  }
  const accountId = String((req.body as Record<string, unknown>).account_id ?? '');
  if (!session.accounts.some((a) => a.id === accountId)) {
    res.status(400).type('html').send(
      renderSelectPage({
        action: '/select-account', field: 'account_id', label: 'Account',
        subtitle: 'Choose the Sinch account to authorize.', error: 'Please select a valid account.',
        options: session.accounts.map((a) => ({ id: a.id, name: a.name })),
      }),
    );
    return;
  }
  updateSession(id, { accountId, stage: 'project' });
  try {
    await proceedToProjectStep(id, res);
  } catch {
    res.status(502).type('html').send(renderTokenPage({ error: 'Could not load projects. Paste a fresh token and retry.' }));
  }
}

/** Fetch projects for the chosen account; auto-skip if exactly one, else render the picker. */
async function proceedToProjectStep(id: string, res: Response): Promise<void> {
  const session = getSession(id)!;
  const projects = await listProjects(
    { token: session.dashboardJwt!, cookie: session.dashboardCookie },
    session.accountId!,
  );
  if (projects.length === 0) {
    res.status(400).type('html').send(renderTokenPage({ error: 'No projects are available in this account.' }));
    return;
  }
  updateSession(id, { projects });
  if (projects.length === 1) {
    await finalize(id, projects[0].id, res);
    return;
  }
  res.type('html').send(
    renderSelectPage({
      action: '/select-project',
      field: 'project_id',
      label: 'Project',
      subtitle: 'Choose the project the agent will act on.',
      options: projects.map((p: Project) => ({ id: p.id, name: p.name })),
    }),
  );
}

export async function handleSelectProject(req: Request, res: Response): Promise<void> {
  const id = sid(req);
  const session = getSession(id);
  if (!id || !session || !session.projects) {
    res.status(400).type('html').send(renderTokenPage({ error: EXPIRED_MSG }));
    return;
  }
  const projectId = String((req.body as Record<string, unknown>).project_id ?? '');
  if (!session.projects.some((p) => p.id === projectId)) {
    res.status(400).type('html').send(
      renderSelectPage({
        action: '/select-project', field: 'project_id', label: 'Project',
        subtitle: 'Choose the project the agent will act on.', error: 'Please select a valid project.',
        options: session.projects.map((p) => ({ id: p.id, name: p.name })),
      }),
    );
    return;
  }
  await finalize(id, projectId, res);
}

/** Stash the pasted token + selection server-side under a cred_ref, then issue the auth code. */
async function finalize(id: string, projectId: string, res: Response): Promise<void> {
  const session = getSession(id) as LoginSession;
  const credRef = putCred({
    dashboardJwt: session.dashboardJwt!,
    dashboardCookie: session.dashboardCookie,
    projectId,
    accountId: session.accountId,
    email: session.email,
  });

  const code = nanoid(48);
  putCode(code, {
    email: session.email ?? '',
    clientId: session.params.clientId,
    redirectUri: session.params.redirectUri,
    scope: session.params.scope,
    codeChallenge: session.params.codeChallenge,
    accountId: session.accountId,
    projectId,
    credRef,
  });

  deleteSession(id);
  redirectWithCode(res, session.params.redirectUri, code, session.params.state);
}

// ── shared ───────────────────────────────────────────────────────────────────
function redirectWithCode(res: Response, redirectUri: string, code: string, state: string): void {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  res.redirect(302, redirect.toString());
}

/** POST /login — dispatches to the local or dashboard handler based on LOGIN_MODE. */
export async function handleLogin(req: Request, res: Response): Promise<void> {
  if (config.loginMode === 'dashboard') return handleDashboardLogin(req, res);
  return handleLocalLogin(req, res);
}
