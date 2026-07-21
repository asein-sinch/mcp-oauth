/**
 * Mock-first end-to-end test for LOGIN_MODE=dashboard + RFC 8693 token exchange.
 * Spawns the built auth server with DASHBOARD_MOCK=1, drives the full OAuth wizard with PKCE
 * via a public (dynamically-registered) client, then exercises the back-channel token exchange.
 *
 * No real secrets: an ephemeral RSA key and dummy client secrets are generated in-process.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://localhost:12345/callback';
const BACKCHANNEL_ID = 'mcp-backchannel';
const BACKCHANNEL_SECRET = 'bcsecret-' + crypto.randomBytes(8).toString('hex');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function decodeJwt(token) {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// minimal cookie jar
function mergeCookies(jar, setCookieHeaders) {
  for (const sc of setCookieHeaders) {
    const [pair] = sc.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function main() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const env = {
    ...process.env,
    PORT: String(PORT),
    ISSUER_URL: BASE,
    AUDIENCE: 'http://localhost:9099/mcp',
    SESSION_SECRET: 'test-session-secret-1234567890',
    PRIVATE_KEY_PEM: privateKey,
    KEY_ID: 'test-key',
    LOGIN_MODE: 'dashboard',
    DASHBOARD_MOCK: '1',
    OAUTH_CLIENTS: JSON.stringify({
      [BACKCHANNEL_ID]: { clientSecret: BACKCHANNEL_SECRET, redirectUris: [] },
    }),
    // USERS defaults to {}
  };

  const srv = spawn('node', ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

  try {
    await waitForHealth();

    // 1. DCR: register a public client (no secret), like MCPJam does.
    const reg = await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });
    const regJson = await reg.json();
    check('DCR returns 201 + client_id', reg.status === 201 && !!regJson.client_id, `status ${reg.status}`);
    check('DCR public client (auth method none)', regJson.token_endpoint_auth_method === 'none');
    const clientId = regJson.client_id;

    // 2. PKCE + authorize: should set the wizard cookie and render the login form.
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const jar = new Map();
    const authUrl =
      `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=demo&state=xyz` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    mergeCookies(jar, authRes.headers.getSetCookie());
    const authBody = await authRes.text();
    check(
      'GET /authorize renders paste form (cookie required, token optional)',
      authRes.status === 200 && authBody.includes('name="dashboard_cookie"') && authBody.includes('name="dashboard_token"'),
    );
    check('GET /authorize sets wizard cookie', jar.has('sid'));

    // 3. POST /login (mock): paste COOKIE ONLY (no token) -> auto-minted via refreshCcpToken ->
    //    single account + project auto-skip -> 302 with code.
    const loginRes = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ dashboard_cookie: 'mock-session-cookie' }),
      redirect: 'manual',
    });
    const loc = loginRes.headers.get('location');
    check('POST /login auto-skips to redirect (302)', loginRes.status === 302 && !!loc, `status ${loginRes.status}`);
    const code = loc ? new URL(loc).searchParams.get('code') : null;
    const stateBack = loc ? new URL(loc).searchParams.get('state') : null;
    check('redirect carries code + state', !!code && stateBack === 'xyz');

    // 4. Token: public client (no secret) + PKCE verifier -> client JWT.
    const tokRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const tokJson = await tokRes.json();
    check('POST /token returns access_token', tokRes.status === 200 && !!tokJson.access_token, `status ${tokRes.status}`);
    const clientJwt = tokJson.access_token;
    const claims = clientJwt ? decodeJwt(clientJwt) : {};
    check('client JWT carries cred_ref', typeof claims.cred_ref === 'string' && claims.cred_ref.length > 0);
    check('client JWT carries project_id', claims.project_id === 'proj_demo');
    check('client JWT has NO subproject_id', !('subproject_id' in claims));
    check(
      'client JWT has NO secret-bearing claims',
      !JSON.stringify(claims).match(/secret|accessKey|dashboard|jwt/i),
      JSON.stringify(claims),
    );

    // 5. Token exchange: confidential back-channel client + client JWT -> mock Sinch token.
    const exRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${BACKCHANNEL_ID}:${BACKCHANNEL_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: clientJwt,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      }),
    });
    const exJson = await exRes.json();
    check('token-exchange returns 200 + Sinch token', exRes.status === 200 && !!exJson.access_token, `status ${exRes.status}`);
    check('token-exchange returns project_id', exJson.project_id === 'proj_demo');
    check('token-exchange token is the mock Sinch token', String(exJson.access_token).startsWith('mock-sinch-token:'));

    // 6. Negative: wrong back-channel secret -> 401.
    const badSecret = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${BACKCHANNEL_ID}:wrong`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: clientJwt,
      }),
    });
    check('token-exchange rejects bad client secret (401)', badSecret.status === 401, `status ${badSecret.status}`);

    // 7. Negative: forged subject_token -> 400.
    const forged = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${BACKCHANNEL_ID}:${BACKCHANNEL_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'not.a.jwt',
      }),
    });
    check('token-exchange rejects forged subject_token (400)', forged.status === 400, `status ${forged.status}`);

    // 8. Empty paste (neither cookie nor token) is rejected at the login step.
    const jar2 = new Map();
    const auth2 = await fetch(authUrl, { redirect: 'manual' });
    mergeCookies(jar2, auth2.headers.getSetCookie());
    const emptyTok = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar2) },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });
    check('empty paste is rejected (400, re-renders form)', emptyTok.status === 400, `status ${emptyTok.status}`);

    // 9. Token-only paste (no cookie) still works — backward compat with the original flow.
    const jar3 = new Map();
    const auth3 = await fetch(authUrl, { redirect: 'manual' });
    mergeCookies(jar3, auth3.headers.getSetCookie());
    const tokOnly = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar3) },
      body: new URLSearchParams({ dashboard_token: 'mock-ccp-token' }),
      redirect: 'manual',
    });
    check('token-only paste (no cookie) still redirects (302)', tokOnly.status === 302, `status ${tokOnly.status}`);
  } finally {
    srv.kill('SIGKILL');
  }

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('server did not become healthy');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
