/**
 * Regression test for LOGIN_MODE=local (USERS -> subproject_id claim, password NOT checked) and
 * the device flow. Ensures the dashboard-mode refactor did not break the existing paths.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://localhost:12345/callback';
const CLIENT_ID = 'web';
const CLIENT_SECRET = 'websecret-' + crypto.randomBytes(6).toString('hex');
const EMAIL = 'demo@sinch.com';
const PASSWORD = 'secret123';
const SUBPROJECT = 'sub_abc123';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

async function main() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const env = {
    ...process.env,
    PORT: String(PORT),
    ISSUER_URL: BASE,
    AUDIENCE: 'http://localhost:9099/mcp',
    SESSION_SECRET: 'test-session-secret-1234567890',
    PRIVATE_KEY_PEM: privateKey,
    KEY_ID: 'test-key',
    // LOGIN_MODE defaults to local
    OAUTH_CLIENTS: JSON.stringify({ [CLIENT_ID]: { clientSecret: CLIENT_SECRET, redirectUris: [REDIRECT_URI] } }),
    USERS: JSON.stringify({ [EMAIL]: { subprojectId: SUBPROJECT } }),
  };
  const srv = spawn('node', ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

  try {
    await waitForHealth();

    // ── Authorization-code flow (local) ──
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const authUrl =
      `${BASE}/authorize?response_type=code&client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=demo&state=st` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const authBody = await (await fetch(authUrl)).text();
    check('local /authorize renders form with hidden client_id', authBody.includes(`name="client_id" value="${CLIENT_ID}"`));

    const loginRes = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: 'demo', state: 'st',
        code_challenge: challenge, email: EMAIL, password: PASSWORD,
      }),
      redirect: 'manual',
    });
    const code = loginRes.headers.get('location') ? new URL(loginRes.headers.get('location')).searchParams.get('code') : null;
    check('local /login -> 302 with code', loginRes.status === 302 && !!code, `status ${loginRes.status}`);

    const tokJson = await (await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code_verifier: verifier,
      }),
    })).json();
    check('local /token returns JWT', !!tokJson.access_token);
    const claims = tokJson.access_token ? decodeJwt(tokJson.access_token) : {};
    check('local JWT has subproject_id', claims.subproject_id === SUBPROJECT);
    check('local JWT has NO cred_ref', !('cred_ref' in claims));

    // The password is no longer checked — a garbage value still succeeds as long as the email
    // resolves to a configured demo user.
    check('local /login ignores the password (garbage value still succeeds)', (await fetch(`${BASE}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: 'demo', state: 'st',
        code_challenge: challenge, email: EMAIL, password: 'anything-goes',
      }), redirect: 'manual',
    })).status === 302);

    // The email is still checked — an unconfigured email is rejected regardless of password.
    check('local /login rejects an unknown email', (await fetch(`${BASE}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: 'demo', state: 'st',
        code_challenge: challenge, email: 'nobody@sinch.com', password: 'irrelevant',
      }), redirect: 'manual',
    })).status === 401);

    // ── Device flow ──
    const da = await (await fetch(`${BASE}/device_authorization`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'demo' }),
    })).json();
    check('device_authorization returns device_code + user_code', !!da.device_code && !!da.user_code);

    const devPost = await fetch(`${BASE}/device`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: da.user_code, email: EMAIL, password: PASSWORD }),
    });
    check('device approval succeeds', devPost.status === 200);

    const devTok = await (await fetch(`${BASE}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: da.device_code, client_id: CLIENT_ID,
      }),
    })).json();
    check('device /token returns JWT with subproject_id', devTok.access_token && decodeJwt(devTok.access_token).subproject_id === SUBPROJECT);

    // ── Metadata advertises all three grants ──
    const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    check('metadata advertises token-exchange grant', meta.grant_types_supported?.includes('urn:ietf:params:oauth:grant-type:token-exchange'));
    check('metadata advertises registration_endpoint', !!meta.registration_endpoint);
  } finally {
    srv.kill('SIGKILL');
  }
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

main().catch((e) => { console.error(e); process.exit(1); });
