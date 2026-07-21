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
  refreshCcpToken,
  listAccounts,
  listProjects,
  getAccessKeyUsage,
  ensureFreshAccessKey,
  ACCESS_KEY_MAX,
  type Account,
  type Project,
} from '../dashboard.js';
import { scriptedLoginStep1, scriptedLoginSubmitOtp } from '../scriptedLogin.js';

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
        <label for="dashboard_cookie">Dashboard cookie</label>
        <textarea id="dashboard_cookie" name="dashboard_cookie" rows="3" required autofocus style="${ta}"></textarea>
        <label for="dashboard_token">Dashboard token <span style="color:#6b7385">(optional — auto-minted from the cookie if left blank)</span></label>
        <textarea id="dashboard_token" name="dashboard_token" rows="5" style="${ta}"></textarea>
        <button type="submit">Continue</button>
      </form>`;
  return renderShell({
    subtitle:
      'Paste your Sinch dashboard <code>Cookie</code> header (Dashboard → DevTools → Network → ' +
      'any <code>graphql</code> or <code>/me</code> request → the <code>Cookie</code> request ' +
      'header). We mint a fresh token from it automatically.',
    error: opts.error,
    form,
  });
}

function renderSelectPage(opts: {
  action: string;
  field: string;
  label: string;
  subtitle: string;
  options: { id: string; name: string; disabled?: boolean; note?: string }[];
  error?: string;
}): string {
  const optionsHtml = opts.options
    .map((o) => {
      const label = o.note ? `${o.name} (${o.note})` : o.name;
      return `<option value="${esc(o.id)}"${o.disabled ? ' disabled' : ''}>${esc(label)}</option>`;
    })
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

// ── scripted mode: real Sinch ID credentials + SMS OTP ────────────────────────
export function renderCredentialsPage(opts: { error?: string; email?: string }): string {
  const form = `
      <form method="post" action="/login">
        <label for="email">Sinch ID email</label>
        <input id="email" name="email" type="email" autocomplete="username" required autofocus value="${esc(opts.email ?? '')}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>`;
  return renderShell({ subtitle: 'Sign in with your real Sinch ID credentials.', error: opts.error, form });
}

export function renderOtpPage(opts: { error?: string }): string {
  const form = `
      <form method="post" action="/otp">
        <label for="code">SMS verification code</label>
        <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required autofocus />
        <button type="submit">Verify</button>
      </form>`;
  return renderShell({ subtitle: 'Enter the verification code we just texted you.', error: opts.error, form });
}

/** Whichever entry screen matches the configured login mode — the generic error/expiry fallback. */
function renderEntryPage(opts: { error?: string; email?: string }): string {
  return config.loginMode === 'scripted' ? renderCredentialsPage(opts) : renderTokenPage(opts);
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
  const user = verifyCredentials(email);
  if (!user) {
    res.status(401).type('html').send(renderLoginPage({ params, error: 'No demo user configured for that email', email }));
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
  const cookie = String(body.dashboard_cookie ?? '').trim() || undefined;
  let token = String(body.dashboard_token ?? '').trim();

  if (!token) {
    if (!cookie) {
      res.status(400).type('html').send(renderTokenPage({ error: 'Paste your dashboard cookie (or a token).' }));
      return;
    }
    try {
      token = await refreshCcpToken(cookie);
    } catch {
      res.status(401).type('html').send(renderTokenPage({ error: 'Could not mint a token from that cookie. Paste a fresh one.' }));
      return;
    }
  }

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
    res.status(400).type('html').send(renderEntryPage({ error: 'No Sinch accounts are visible with this token.' }));
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
    res.status(400).type('html').send(renderEntryPage({ error: EXPIRED_MSG }));
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
    res.status(502).type('html').send(renderEntryPage({ error: 'Could not load projects. Please sign in again.' }));
  }
}

/** Fetch projects for the chosen account; auto-skip if exactly one, else render the picker.
 * Each project's access-key usage is fetched alongside so at-cap projects can be greyed out —
 * Sinch caps access keys at ACCESS_KEY_MAX per project, and creating one would otherwise fail
 * opaquely at finalize() time. */
async function proceedToProjectStep(id: string, res: Response): Promise<void> {
  const session = getSession(id)!;
  const creds = { token: session.dashboardJwt!, cookie: session.dashboardCookie };
  const projects = await listProjects(creds, session.accountId!);
  if (projects.length === 0) {
    res.status(400).type('html').send(renderEntryPage({ error: 'No projects are available in this account.' }));
    return;
  }

  const usageEntries = await Promise.all(
    projects.map(async (p) => [p.id, await getAccessKeyUsage(creds, session.accountId!, p.id)] as const),
  );
  const projectUsage = Object.fromEntries(usageEntries);
  updateSession(id, { projects, projectUsage });

  if (projects.length === 1) {
    if (projectUsage[projects[0].id]?.atCap) {
      res.status(409).type('html').send(
        renderEntryPage({ error: 'This project already has 10/10 access keys. Delete one from the dashboard and retry.' }),
      );
      return;
    }
    await finalize(id, projects[0].id, res);
    return;
  }
  res.type('html').send(
    renderSelectPage({
      action: '/select-project',
      field: 'project_id',
      label: 'Project',
      subtitle: 'Choose the project the agent will act on.',
      options: projects.map((p: Project) => projectOption(p, projectUsage[p.id])),
    }),
  );
}

function projectOption(
  p: Project,
  usage: { count: number; atCap: boolean } | undefined,
): { id: string; name: string; disabled?: boolean; note?: string } {
  return {
    id: p.id,
    name: p.name,
    disabled: usage?.atCap,
    note: usage?.atCap ? `${usage.count}/${ACCESS_KEY_MAX} keys — unavailable` : undefined,
  };
}

export async function handleSelectProject(req: Request, res: Response): Promise<void> {
  const id = sid(req);
  const session = getSession(id);
  if (!id || !session || !session.projects) {
    res.status(400).type('html').send(renderEntryPage({ error: EXPIRED_MSG }));
    return;
  }
  const projectId = String((req.body as Record<string, unknown>).project_id ?? '');
  const usage = session.projectUsage?.[projectId];
  const isValid = session.projects.some((p) => p.id === projectId);
  // Defense-in-depth: a disabled <option> shouldn't be submittable, but re-check server-side too.
  if (!isValid || usage?.atCap) {
    res.status(400).type('html').send(
      renderSelectPage({
        action: '/select-project', field: 'project_id', label: 'Project',
        subtitle: 'Choose the project the agent will act on.',
        error: usage?.atCap ? 'That project has reached its access-key limit. Choose another.' : 'Please select a valid project.',
        options: session.projects.map((p) => projectOption(p, session.projectUsage?.[p.id])),
      }),
    );
    return;
  }
  await finalize(id, projectId, res);
}

/**
 * scripted mode: mint the access key immediately and issue an auth code that carries the raw
 * static token — no back-channel exchange needed. dashboard mode: stash the token/cookie under a
 * cred_ref and mint Sinch M2M credentials lazily via RFC 8693 token exchange instead.
 */
async function finalize(id: string, projectId: string, res: Response): Promise<void> {
  const session = getSession(id) as LoginSession;

  if (config.loginMode === 'scripted') {
    try {
      // The cookie can always mint a guaranteed-fresh CCP token; prefer it over whatever JWT we
      // derived at login time.
      const jwt = session.dashboardCookie ? await refreshCcpToken(session.dashboardCookie) : session.dashboardJwt!;
      const key = await ensureFreshAccessKey({ token: jwt, cookie: session.dashboardCookie }, session.accountId!, projectId);
      const staticToken = Buffer.from(`${projectId}:${key.accessKeyId}:${key.accessKeySecret}`).toString('base64');

      const code = nanoid(48);
      putCode(code, {
        email: session.email ?? '',
        clientId: session.params.clientId,
        redirectUri: session.params.redirectUri,
        scope: session.params.scope,
        codeChallenge: session.params.codeChallenge,
        accountId: session.accountId,
        projectId,
        staticToken,
      });

      deleteSession(id);
      redirectWithCode(res, session.params.redirectUri, code, session.params.state);
    } catch {
      res.status(502).type('html').send(renderCredentialsPage({ error: 'Could not create an access key for that project. Please try again.' }));
    }
    return;
  }

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

// ── scripted mode: real Sinch ID credentials + SMS OTP ────────────────────────

async function handleCredentials(req: Request, res: Response): Promise<void> {
  const id = sid(req);
  const session = getSession(id);
  if (!id || !session) {
    res.status(400).type('html').send(renderCredentialsPage({ error: EXPIRED_MSG }));
    return;
  }

  const body = req.body as Record<string, unknown>;
  const email = String(body.email ?? '').trim();
  const password = String(body.password ?? '');
  if (!email || !password) {
    res.status(400).type('html').send(renderCredentialsPage({ error: 'Email and password are required.', email }));
    return;
  }

  let result;
  try {
    result = await scriptedLoginStep1(email, password);
  } catch (err) {
    res.status(401).type('html').send(
      renderCredentialsPage({ error: err instanceof Error ? err.message : 'Sign-in failed.', email }),
    );
    return;
  }

  if (!result.done) {
    updateSession(id, { stage: 'otp', email, otpPending: result.mfa });
    res.type('html').send(renderOtpPage({}));
    return;
  }

  updateSession(id, { stage: 'account', email, dashboardCookie: result.cookie });
  try {
    await proceedToAccountStep(id, res);
  } catch {
    res.status(502).type('html').send(
      renderCredentialsPage({ error: 'Signed in, but the dashboard rejected the session. Please try again.', email }),
    );
  }
}

export async function handleOtp(req: Request, res: Response): Promise<void> {
  const id = sid(req);
  const session = getSession(id);
  if (!id || !session || !session.otpPending) {
    res.status(400).type('html').send(renderCredentialsPage({ error: EXPIRED_MSG }));
    return;
  }

  const code = String((req.body as Record<string, unknown>).code ?? '').trim();
  if (!code) {
    res.status(400).type('html').send(renderOtpPage({ error: 'Enter the verification code.' }));
    return;
  }

  let cookie: string;
  try {
    cookie = await scriptedLoginSubmitOtp(session.otpPending, code);
  } catch (err) {
    res.status(401).type('html').send(
      renderOtpPage({ error: err instanceof Error ? err.message : 'Verification failed.' }),
    );
    return;
  }

  updateSession(id, { stage: 'account', dashboardCookie: cookie, otpPending: undefined });
  try {
    await proceedToAccountStep(id, res);
  } catch {
    res.status(502).type('html').send(
      renderCredentialsPage({ error: 'Signed in, but the dashboard rejected the session. Please try again.' }),
    );
  }
}

// ── shared ───────────────────────────────────────────────────────────────────
function redirectWithCode(res: Response, redirectUri: string, code: string, state: string): void {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  res.redirect(302, redirect.toString());
}

/** POST /login — dispatches to the local, dashboard, or scripted handler based on LOGIN_MODE. */
export async function handleLogin(req: Request, res: Response): Promise<void> {
  if (config.loginMode === 'dashboard') return handleDashboardLogin(req, res);
  if (config.loginMode === 'scripted') return handleCredentials(req, res);
  return handleLocalLogin(req, res);
}
