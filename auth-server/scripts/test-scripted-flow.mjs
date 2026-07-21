/**
 * Mock-first end-to-end test for LOGIN_MODE=scripted (real-credentials "Cursor simulation").
 * Spawns the built auth server with DASHBOARD_MOCK=1, drives the credentials + OTP screens via a
 * public (dynamically-registered) client, then decodes the returned static token.
 *
 * No real secrets: an ephemeral RSA key and dummy client secrets are generated in-process.
 * scriptedLogin.ts's mock branch (config.dashboardMock) simulates Auth0 without any network calls:
 *   - password === 'wrong'      -> invalid credentials
 *   - email contains 'nomfa'    -> no MFA challenge, straight through
 *   - otherwise                 -> MFA challenge; code === '000000' -> invalid code, else success
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = 8095;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://localhost:12345/callback';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function mergeCookies(jar, setCookieHeaders) {
  for (const sc of setCookieHeaders) {
    const [pair] = sc.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

function baseEnv(port) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    ...process.env,
    PORT: String(port),
    ISSUER_URL: `http://localhost:${port}`,
    AUDIENCE: 'http://localhost:9095/mcp',
    SESSION_SECRET: 'test-session-secret-1234567890',
    PRIVATE_KEY_PEM: privateKey,
    KEY_ID: 'test-key',
    LOGIN_MODE: 'scripted',
    DASHBOARD_MOCK: '1',
    OAUTH_CLIENTS: JSON.stringify({}),
  };
}

async function waitForHealth(base) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

/** Register a public client + start /authorize with PKCE; returns { clientId, verifier, jar }. */
async function beginAuth(base) {
  const reg = await (await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
  })).json();
  const clientId = reg.client_id;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(sha256(verifier));
  const jar = new Map();
  const authUrl =
    `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=demo&state=xyz` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  mergeCookies(jar, authRes.headers.getSetCookie());
  return { clientId, verifier, jar, authBody: await authRes.text(), authStatus: authRes.status };
}

async function main() {
  const srv = spawn('node', ['dist/server.js'], { env: baseEnv(PORT), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

  try {
    await waitForHealth(BASE);

    // 1. /authorize renders the real-credentials form (not the paste-token form).
    const { clientId, verifier, jar, authBody, authStatus } = await beginAuth(BASE);
    check('GET /authorize renders credentials form', authStatus === 200 && authBody.includes('name="password"') && authBody.includes('name="email"'));
    check('credentials form has no dashboard_token/cookie fields', !authBody.includes('dashboard_token') && !authBody.includes('dashboard_cookie'));

    // 2. Wrong password -> 401, stays on the credentials page.
    const wrongPw = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ email: 'demo@sinch.com', password: 'wrong' }),
    });
    check('wrong password rejected (401)', wrongPw.status === 401, `status ${wrongPw.status}`);

    // 3. Correct credentials (default email) -> MFA challenge -> OTP page.
    const otpPage = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ email: 'demo@sinch.com', password: 'correct' }),
    });
    const otpBody = await otpPage.text();
    check('correct credentials render the OTP page', otpPage.status === 200 && otpBody.includes('name="code"'), `status ${otpPage.status}`);

    // 4. Wrong OTP code -> 401, stays on the OTP page.
    const wrongOtp = await fetch(`${BASE}/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ code: '000000' }),
    });
    check('wrong OTP code rejected (401)', wrongOtp.status === 401, `status ${wrongOtp.status}`);

    // 5. Correct OTP -> single mock account/project auto-skip -> 302 with code.
    const otpOk = await fetch(`${BASE}/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ code: '123456' }),
      redirect: 'manual',
    });
    const loc = otpOk.headers.get('location');
    check('correct OTP -> redirect with code (302)', otpOk.status === 302 && !!loc, `status ${otpOk.status}`);
    const code = loc ? new URL(loc).searchParams.get('code') : null;
    const stateBack = loc ? new URL(loc).searchParams.get('state') : null;
    check('redirect carries code + state', !!code && stateBack === 'xyz');

    // 6. Token exchange (authorization_code + PKCE, public client) -> raw static token.
    const tok = await (await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier,
      }),
    })).json();
    check('POST /token returns access_token', !!tok.access_token);

    const decoded = Buffer.from(tok.access_token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    check(
      'access_token decodes to base64("projectId:accessKey:accessSecret")',
      parts.length === 3 && parts[0] === 'proj_demo' && parts[1] === 'mockkey_proj_demo' && parts[2] === 'mock-secret',
      `decoded: ${decoded}`,
    );
    check('access_token is NOT a JWT (no dots in the raw base64)', !tok.access_token.includes('.'));

    // 7. "nomfa" email skips the OTP screen entirely -> straight to redirect.
    const { verifier: v2, jar: jar2, clientId: clientId2 } = await beginAuth(BASE);
    const noMfaRes = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar2) },
      body: new URLSearchParams({ email: 'nomfa@sinch.com', password: 'correct' }),
      redirect: 'manual',
    });
    check('no-MFA account skips straight to redirect (302)', noMfaRes.status === 302, `status ${noMfaRes.status}`);
    void v2; void clientId2;
  } finally {
    srv.kill('SIGKILL');
  }

  // 8. Access-key cap: a second server instance where every project reports at-cap. With only
  // one mock project, the auto-skip path must block finalize() with a clear error, not a 302.
  const CAP_PORT = 8094;
  const capEnv = { ...baseEnv(CAP_PORT), DASHBOARD_MOCK_AT_CAP: '1' };
  const capSrv = spawn('node', ['dist/server.js'], { env: capEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  capSrv.stderr.on('data', (d) => process.stderr.write(`[cap-srv] ${d}`));
  try {
    const CAP_BASE = `http://127.0.0.1:${CAP_PORT}`;
    await waitForHealth(CAP_BASE);
    const { jar } = await beginAuth(CAP_BASE);
    // "nomfa" email to skip straight past the OTP screen to the project auto-skip check.
    const res = await fetch(`${CAP_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ email: 'nomfa@sinch.com', password: 'correct' }),
      redirect: 'manual',
    });
    check('at-cap single project blocks finalize (409, no redirect)', res.status === 409, `status ${res.status}`);
  } finally {
    capSrv.kill('SIGKILL');
  }

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
