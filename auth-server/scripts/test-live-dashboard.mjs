/**
 * LIVE smoke test for the dashboard integration. Hits the real dashboard.api.sinch.com with your
 * pasted CCP token and walks the full credential chain:
 *   /api/v1/me  ->  ListParentProjects  ->  CreateAccessKey  ->  client_credentials  ->  delete
 *
 * It NEVER prints tokens, access keys, secrets, or project/account IDs — only counts, display
 * names, and pass/fail. The token is read from a file (arg or ./.dashboard-token) or $DASHBOARD_TOKEN,
 * so it never lands in shell history.
 *
 * Usage:
 *   echo '<paste CCP token>' > .dashboard-token        # gitignored
 *   node scripts/test-live-dashboard.mjs
 *   # optionally pin a specific project by display name:  PROJECT_NAME="My Project" node ...
 */
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

function readFileFirst(candidates, envVar) {
  for (const f of candidates.filter(Boolean)) {
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  }
  return process.env[envVar]?.trim();
}

function readToken() {
  const token = readFileFirst([process.argv[2], '.dashboard-token', 'scripts/.dashboard-token'], 'DASHBOARD_TOKEN');
  if (!token) {
    console.error('No token. Put it in ./.dashboard-token (gitignored) or set $DASHBOARD_TOKEN.');
    process.exit(2);
  }
  return token;
}

// Optional session cookie (some dashboard calls need it alongside the bearer).
function readCookie() {
  return readFileFirst(['.dashboard-cookie', 'scripts/.dashboard-cookie'], 'DASHBOARD_COOKIE');
}

async function main() {
  const token = readToken();
  const cookie = readCookie();
  const creds = { token, cookie };

  // Satisfy config.ts validation (dashboard.ts imports it). None of these touch the real calls.
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  Object.assign(process.env, {
    ISSUER_URL: 'http://localhost:8080',
    AUDIENCE: 'http://localhost:9090/mcp',
    SESSION_SECRET: 'live-smoke-session-secret',
    PRIVATE_KEY_PEM: privateKey,
    OAUTH_CLIENTS: '{}',
    LOGIN_MODE: 'dashboard',
  });
  delete process.env.DASHBOARD_MOCK; // real calls

  const dash = await import('../dist/dashboard.js');

  const inspected = dash.inspectDashboardToken(token);
  if (!inspected.valid) {
    console.error(`✗ token rejected: ${inspected.reason}`);
    process.exit(1);
  }
  console.log(`✓ token looks valid (sub present: ${Boolean(inspected.sub)}); cookie provided: ${Boolean(cookie)}`);

  const accounts = await dash.listAccounts(creds);
  console.log(`✓ /api/v1/me -> ${accounts.length} account(s): ${accounts.map((a) => a.name).join(', ')}`);

  const account = process.env.ACCOUNT_NAME
    ? accounts.find((a) => a.name === process.env.ACCOUNT_NAME) ?? accounts[0]
    : accounts[0];

  const projects = await dash.listProjects(creds, account.id);
  console.log(`✓ ListParentProjects -> ${projects.length} project(s): ${projects.map((p) => p.name).join(', ')}`);
  if (projects.length === 0) { console.error('✗ no projects; cannot continue'); process.exit(1); }

  const project = process.env.PROJECT_NAME
    ? projects.find((p) => p.name === process.env.PROJECT_NAME) ?? projects[0]
    : projects[0];
  console.log(`  using project: ${project.name}`);

  const key = await dash.ensureFreshAccessKey(creds, account.id, project.id);
  console.log('✓ CreateAccessKey -> got id + secret (not printed)');

  try {
    const m2m = await dash.clientCredentialsToken(key);
    console.log(`✓ client_credentials -> Sinch M2M token obtained (expires_in=${m2m.expiresIn})`);
  } finally {
    await dash.deleteAccessKeyQuietly(creds, account.id, key.accessKeyId);
    console.log('✓ cleanup -> access key deleted');
  }

  console.log('\n✅ LIVE CHAIN OK — token -> account -> project -> key -> M2M token -> cleanup');
}

main().catch((err) => {
  console.error(`\n✗ FAILED: ${err.message}`);
  process.exit(1);
});
