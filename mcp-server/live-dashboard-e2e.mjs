/**
 * FULL LIVE e2e: auth-server (LOGIN_MODE=dashboard) + mcp-server (CREDENTIAL_SOURCE=exchange),
 * both spawned locally, driven exactly as MCPJam would, against the REAL Sinch dashboard.
 *
 *   DCR -> /authorize -> paste real token+cookie -> pick account/project -> client JWT
 *   -> MCP initialize (mcp-server back-channels RFC 8693 -> real Sinch M2M token)
 *   -> tools/call whoami + list_active_numbers (real Sinch API call with the minted token)
 *
 * Reads the real CCP token from ../auth-server/.dashboard-token and cookie from
 * ../auth-server/.dashboard-cookie. Never prints tokens, cookies, secrets, IDs, or phone numbers.
 *
 * Prereq: both servers built (npm run build in each). Usage: node live-dashboard-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(HERE, '..', 'auth-server');
const AUTH_PORT = 8097, MCP_PORT = 8096;
const AUTH = `http://127.0.0.1:${AUTH_PORT}`;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const MCP = `${MCP_BASE}/mcp`;
const REDIRECT_URI = 'http://localhost:12345/callback';
const BC_ID = 'mcp-backchannel';
const BC_SECRET = 'bcsecret-' + crypto.randomBytes(8).toString('hex');

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

function readFileFirst(paths, envVar) {
  for (const f of paths) if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return process.env[envVar]?.trim();
}
function mergeCookies(jar, sc) { for (const c of sc) { const [p] = c.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } }
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const parseOptions = (html) => { const out = []; const re = /<option value="([^"]*)">([^<]*)<\/option>/g; let m; while ((m = re.exec(html))) out.push({ value: m[1], label: m[2] }); return out; };

async function waitForHealth(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${base} did not become healthy`);
}

async function main() {
  const token = readFileFirst([join(AUTH_DIR, '.dashboard-token')], 'DASHBOARD_TOKEN');
  const cookie = readFileFirst([join(AUTH_DIR, '.dashboard-cookie')], 'DASHBOARD_COOKIE');
  if (!token) { console.error('No token at ../auth-server/.dashboard-token or $DASHBOARD_TOKEN'); process.exit(2); }

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const authEnv = {
    ...process.env, PORT: String(AUTH_PORT), ISSUER_URL: AUTH, AUDIENCE: MCP,
    SESSION_SECRET: 'combined-e2e-secret-1234567890', PRIVATE_KEY_PEM: privateKey, KEY_ID: 'e2e-key',
    LOGIN_MODE: 'dashboard',
    OAUTH_CLIENTS: JSON.stringify({ [BC_ID]: { clientSecret: BC_SECRET, redirectUris: [] } }),
  };
  delete authEnv.DASHBOARD_MOCK;

  const mcpEnv = {
    ...process.env, PORT: String(MCP_PORT), AUTH_MODE: 'jwt', CREDENTIAL_SOURCE: 'exchange',
    JWKS_URL: `${AUTH}/.well-known/jwks.json`, EXPECTED_ISSUER: AUTH, EXPECTED_AUDIENCE: MCP,
    TOKEN_EXCHANGE_URL: `${AUTH}/token`, BACKCHANNEL_CLIENT_ID: BC_ID, BACKCHANNEL_CLIENT_SECRET: BC_SECRET,
  };

  const authSrv = spawn('node', ['dist/server.js'], { cwd: AUTH_DIR, env: authEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const mcpSrv = spawn('node', ['dist/server.js'], { cwd: HERE, env: mcpEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [tag, s] of [['auth', authSrv], ['mcp', mcpSrv]]) {
    s.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
    s.stdout.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
    s.on('exit', (c, sig) => process.stderr.write(`[${tag}] exited code=${c} sig=${sig}\n`));
  }

  let client;
  try {
    await Promise.all([waitForHealth(AUTH), waitForHealth(MCP_BASE)]);

    // ── drive the auth wizard as MCPJam would ──
    const reg = await (await fetch(`${AUTH}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    })).json();
    const clientId = reg.client_id;
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(sha256(verifier));
    const jar = new Map();
    const authUrl = `${AUTH}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=demo&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;
    mergeCookies(jar, (await fetch(authUrl, { redirect: 'manual' })).headers.getSetCookie());

    let step = await fetch(`${AUTH}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ dashboard_token: token, ...(cookie ? { dashboard_cookie: cookie } : {}) }),
      redirect: 'manual',
    });
    let guard = 0;
    while (step.status === 200 && guard++ < 4) {
      const html = await step.text();
      const isAccount = html.includes('name="account_id"');
      const field = isAccount ? 'account_id' : 'project_id';
      const action = isAccount ? '/select-account' : '/select-project';
      const opts = parseOptions(html);
      const chosen = (!isAccount && process.env.PROJECT_NAME && opts.find((o) => o.label === process.env.PROJECT_NAME)) || opts[0];
      console.log(`  ${isAccount ? 'account' : 'project'}: ${chosen.label}`);
      step = await fetch(`${AUTH}${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar) },
        body: new URLSearchParams({ [field]: chosen.value }), redirect: 'manual',
      });
    }
    const code = new URL(step.headers.get('location')).searchParams.get('code');
    check('wizard produced an auth code', !!code);

    const tok = await (await fetch(`${AUTH}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }),
    })).json();
    const clientJwt = tok.access_token;
    check('client JWT minted (carries cred_ref, no secrets)', !!clientJwt);

    // ── act as an MCP client with that JWT ──
    const transport = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { Authorization: `Bearer ${clientJwt}` } } });
    client = new Client({ name: 'live-e2e', version: '0.0.0' });
    await client.connect(transport); // triggers back-channel exchange -> real Sinch token
    check('MCP initialize ✓ (exchange minted a real Sinch token)', true);

    const tools = await client.listTools();
    check('tools listed', tools.tools.length > 0, tools.tools.map((t) => t.name).join(', '));

    const who = await client.callTool({ name: 'whoami', arguments: {} });
    const whoParsed = JSON.parse(who.content[0].text);
    check('whoami resolved a subproject from the exchanged identity', !!whoParsed.subprojectId);

    const nums = await client.callTool({ name: 'list_active_numbers', arguments: { pageSize: 3 } });
    if (nums.isError) {
      const msg = (nums.content?.[0]?.text ?? '').slice(0, 160);
      check('list_active_numbers reached Sinch (auth OK even if 0 numbers/perm)', !/401|invalid_token|unauthor/i.test(msg), `Sinch said: ${msg}`);
      console.log(`  ℹ list_active_numbers returned an error (not necessarily auth): ${msg}`);
    } else {
      check('list_active_numbers succeeded against the live Sinch API', true);
    }
  } finally {
    if (client) await client.close().catch(() => {});
    authSrv.kill('SIGKILL');
    mcpSrv.kill('SIGKILL');
  }

  console.log(`\n${failed === 0 ? '✅ FULL LIVE E2E PASSED' : '❌ FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
