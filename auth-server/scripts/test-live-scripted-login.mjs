/**
 * LIVE, INTERACTIVE verification of LOGIN_MODE=scripted against the REAL Sinch ID (Auth0) login
 * and REAL dashboard — drives the exact wizard a "Cursor" OAuth client would, with real
 * credentials and a real SMS OTP typed in at the prompt.
 *
 * Credentials are read from environment variables ONLY — never written to a file, never printed.
 * Run it like:
 *
 *   SCRIPTED_LOGIN_EMAIL=you@sinch.com SCRIPTED_LOGIN_PASSWORD='...' \
 *     node scripts/test-live-scripted-login.mjs
 *
 * (export them in your own shell right before running, or paste at the prompt below if omitted —
 * either way this script never logs them.) When the SMS code arrives, type it at the prompt.
 *
 * Prereq: `npm run build` first.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';

const PORT = 8093;
const BASE = `http://localhost:${PORT}`;
const REDIRECT_URI = 'http://localhost:12345/callback';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function mergeCookies(jar, setCookieHeaders) {
  for (const sc of setCookieHeaders) {
    const [pair] = sc.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

/** Pull the rendered <div class="error">...</div> text out of a login-card page, if present. */
function extractError(html) {
  const m = html.match(/<div class="error">([^<]*)<\/div>/);
  if (!m) return null;
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

async function main() {
  const email = process.env.SCRIPTED_LOGIN_EMAIL || (await prompt('Sinch ID email: '));
  const password = process.env.SCRIPTED_LOGIN_PASSWORD || (await prompt('Sinch ID password (not echoed to a file or logged): '));
  if (!email || !password) { console.error('Email and password are required.'); process.exit(2); }

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const env = {
    ...process.env,
    PORT: String(PORT), ISSUER_URL: BASE, AUDIENCE: 'http://localhost:9093/mcp',
    SESSION_SECRET: 'live-scripted-login-secret', PRIVATE_KEY_PEM: privateKey, KEY_ID: 'live-key',
    LOGIN_MODE: 'scripted', OAUTH_CLIENTS: '{}',
  };
  delete env.DASHBOARD_MOCK;

  const srv = spawn('node', ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

  try {
    await waitForHealth();

    const reg = await (await fetch(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    })).json();
    const clientId = reg.client_id;
    console.log(`✓ registered client ${clientId.slice(0, 8)}...`);

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const jar = new Map();
    const authUrl =
      `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=demo&state=xyz` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    mergeCookies(jar, (await fetch(authUrl, { redirect: 'manual' })).headers.getSetCookie());
    console.log('✓ /authorize rendered the credentials form');

    console.log('\nsigning in to Sinch ID (this is scripting the real Auth0 login chain)...');
    let step = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ email, password }),
      redirect: 'manual',
    });

    // Single loop: keep handling whatever page comes back (OTP, account picker, project picker)
    // until the final redirect (302) or an unrecoverable error. Every exit path prints the
    // rendered error message (never raw HTML, never credentials) so a failure is diagnosable.
    let guard = 0;
    while (step.status === 200 && guard++ < 6) {
      const html = await step.text();

      if (html.includes('name="code"')) {
        console.log('✓ MFA challenge triggered — check your phone for the SMS code');
        const code = await prompt('SMS code: ');
        step = await fetch(`${BASE}/otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
          body: new URLSearchParams({ code }),
          redirect: 'manual',
        });
        continue;
      }

      const isAccount = html.includes('name="account_id"');
      const isProject = html.includes('name="project_id"');
      if (!isAccount && !isProject) {
        throw new Error(`unexpected page (neither OTP, account, nor project picker) — server said: ${extractError(html) ?? '(no error message found)'}`);
      }
      const field = isAccount ? 'account_id' : 'project_id';
      const action = isAccount ? '/select-account' : '/select-project';
      const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
        .map((m) => ({ value: m[1], disabled: m[2].includes('disabled'), label: m[3] }));
      const available = options.filter((o) => !o.disabled);
      console.log(`  ${isAccount ? 'account' : 'project'} options: ${options.map((o) => `${o.label}${o.disabled ? ' [DISABLED]' : ''}`).join(', ')}`);
      if (!available.length) throw new Error('every option is disabled (at the access-key cap?)');
      step = await fetch(`${BASE}${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
        body: new URLSearchParams({ [field]: available[0].value }),
        redirect: 'manual',
      });
    }

    if (step.status !== 302) {
      const body = await step.text().catch(() => '');
      throw new Error(`expected a redirect with an auth code, got HTTP ${step.status} — server said: ${extractError(body) ?? '(no error message found)'}`);
    }
    const code = new URL(step.headers.get('location')).searchParams.get('code');
    console.log('✓ wizard complete — got an authorization code');

    const tok = await (await fetch(`${BASE}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier,
      }),
    })).json();
    if (!tok.access_token) {
      throw new Error(`/token did not return an access_token: ${JSON.stringify(tok)}`);
    }

    const decoded = Buffer.from(tok.access_token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) {
      throw new Error('access_token did not decode to "projectId:accessKey:accessSecret"');
    }
    console.log(`✓ access_token decodes to a real static token for project ${parts[0]} (key/secret not printed)`);
    writeFileSync('.scripted-static-token', tok.access_token, 'utf8');
    console.log('✓ wrote the raw access_token to ./.scripted-static-token (gitignored, not printed)');
    console.log('\n✅ LIVE SCRIPTED LOGIN OK — real email/password/OTP -> real Sinch access key, base64-encoded.');
    console.log('   Use it: `Authorization: Bearer $(cat .scripted-static-token)` against the');
    console.log('   static-token MCP server (AUTH_MODE=static-token).');
  } finally {
    srv.kill('SIGKILL');
  }
}

main().catch((err) => { console.error(`\n✗ FAILED: ${err.message}`); process.exit(1); });
