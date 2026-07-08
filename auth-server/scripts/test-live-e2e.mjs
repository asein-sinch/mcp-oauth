/**
 * LIVE end-to-end for LOGIN_MODE=dashboard against the REAL dashboard + RFC 8693 exchange.
 * Spawns the built auth server (non-mock), then drives the full browser wizard as MCPJam would:
 *   DCR -> /authorize -> paste real token+cookie -> account/project selection -> code
 *   -> /token (client JWT with cred_ref) -> token-exchange -> REAL Sinch M2M token.
 *
 * Reads the real CCP token from ./.dashboard-token (or $DASHBOARD_TOKEN) and the session cookie
 * from ./.dashboard-cookie (or $DASHBOARD_COOKIE). Never prints tokens, cookies, secrets, or IDs.
 * Creates a throwaway access key and lets the server clean it up.
 *
 * Usage:  node scripts/test-live-e2e.mjs        (optionally PROJECT_NAME="My Project")
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

const PORT = 8098;
const BASE = `http://localhost:${PORT}`;
const REDIRECT_URI = 'http://localhost:12345/callback';
const BACKCHANNEL_ID = 'mcp-backchannel';
const BACKCHANNEL_SECRET = 'bcsecret-' + crypto.randomBytes(8).toString('hex');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const decodeJwt = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

function mergeCookies(jar, setCookies) {
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

function readFileFirst(candidates, envVar) {
  for (const f of candidates.filter(Boolean)) if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return process.env[envVar]?.trim();
}
// Parse <option value="ID">Label</option> pairs from a select page.
function parseOptions(html) {
  const out = [];
  const re = /<option value="([^"]*)">([^<]*)<\/option>/g;
  let m;
  while ((m = re.exec(html))) out.push({ value: m[1], label: m[2] });
  return out;
}

async function main() {
  const token = readFileFirst(['.dashboard-token', 'scripts/.dashboard-token'], 'DASHBOARD_TOKEN');
  const cookie = readFileFirst(['.dashboard-cookie', 'scripts/.dashboard-cookie'], 'DASHBOARD_COOKIE');
  if (!token) { console.error('No token (./.dashboard-token or $DASHBOARD_TOKEN).'); process.exit(2); }

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const env = {
    ...process.env,
    PORT: String(PORT),
    ISSUER_URL: BASE,
    AUDIENCE: 'http://localhost:9098/mcp',
    SESSION_SECRET: 'live-e2e-session-secret-1234567890',
    PRIVATE_KEY_PEM: privateKey,
    KEY_ID: 'live-e2e-key',
    LOGIN_MODE: 'dashboard',
    OAUTH_CLIENTS: JSON.stringify({ [BACKCHANNEL_ID]: { clientSecret: BACKCHANNEL_SECRET, redirectUris: [] } }),
  };
  delete env.DASHBOARD_MOCK; // real dashboard

  const srv = spawn('node', ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

  try {
    await waitForHealth();

    // 1. DCR (public client, like MCPJam).
    const reg = await (await fetch(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    })).json();
    const clientId = reg.client_id;
    check('DCR returns client_id', !!clientId);

    // 2. PKCE + /authorize -> paste-token form + wizard cookie.
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const jar = new Map();
    const authUrl =
      `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=demo&state=xyz` +
      `&code_challenge=${challenge}&code_challenge_method=S256`;
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    mergeCookies(jar, authRes.headers.getSetCookie());
    check('/authorize renders paste-token form', (await authRes.text()).includes('name="dashboard_token"'));

    // 3. POST /login with the REAL token + cookie.
    let step = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ dashboard_token: token, ...(cookie ? { dashboard_cookie: cookie } : {}) }),
      redirect: 'manual',
    });

    // 4. Walk any selection steps (account, then project) until we get the 302 with the code.
    let guard = 0;
    while (step.status === 200 && guard++ < 4) {
      const html = await step.text();
      const isAccount = html.includes('name="account_id"');
      const isProject = html.includes('name="project_id"');
      if (!isAccount && !isProject) {
        check('login step returned an unexpected page', false, 'no select field found');
        break;
      }
      const field = isAccount ? 'account_id' : 'project_id';
      const action = isAccount ? '/select-account' : '/select-project';
      const opts = parseOptions(html);
      check(`${field} picker lists options`, opts.length > 0, `${opts.length} options`);
      const chosen =
        (isProject && process.env.PROJECT_NAME && opts.find((o) => o.label === process.env.PROJECT_NAME)) || opts[0];
      if (isProject) console.log(`  using project: ${chosen.label}`);
      else console.log(`  using account: ${chosen.label}`);
      step = await fetch(`${BASE}${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
        body: new URLSearchParams({ [field]: chosen.value }),
        redirect: 'manual',
      });
    }

    const loc = step.headers.get('location');
    check('wizard completes -> 302 with code', step.status === 302 && !!loc, `status ${step.status}`);
    const code = loc ? new URL(loc).searchParams.get('code') : null;

    // 5. Code -> client JWT (public client + PKCE). Assert NO secrets in the JWT.
    const tok = await (await fetch(`${BASE}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT_URI,
        client_id: clientId, code_verifier: verifier,
      }),
    })).json();
    const clientJwt = tok.access_token;
    check('POST /token returns client JWT', !!clientJwt);
    const claims = clientJwt ? decodeJwt(clientJwt) : {};
    check('client JWT carries cred_ref + project_id', !!claims.cred_ref && !!claims.project_id);
    check('client JWT has NO secret-bearing claims', !JSON.stringify(claims).match(/secret|accessKey|cookie|dashboard|eyJ/i));

    // 6. RFC 8693 exchange -> REAL Sinch M2M token (mints + uses a real access key server-side).
    const ex = await fetch(`${BASE}/token`, {
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
    const exJson = await ex.json();
    check('token-exchange returns 200', ex.status === 200, `status ${ex.status} ${JSON.stringify(exJson).slice(0, 200)}`);
    check('exchange returned a REAL Sinch token', !!exJson.access_token && !String(exJson.access_token).startsWith('mock-'));
    check('exchange returned project_id + expires_in', !!exJson.project_id && exJson.expires_in > 0);
  } finally {
    srv.kill('SIGKILL');
  }

  console.log(`\n${failed === 0 ? '✅ LIVE E2E PASSED' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
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
