/**
 * LIVE verification: does a CCP token minted via refreshCcpToken(cookie) work as a Bearer token
 * against a DIFFERENT dashboard microservice than the one dashboard.ts normally calls?
 *
 * dashboard.ts talks to dashboard.api.sinch.com/graphql. This script mints a token from the
 * session cookie alone, then uses it against sms.web-core.dashboard.api.sinch.com/graphql (the
 * OperatorList query) — proving the minted token is a general-purpose dashboard bearer, not
 * scoped to one backend.
 *
 * Never prints the cookie, the token, or the account id. Operator names/country codes returned by
 * this query are public telecom directory data, not secrets, so a short sample is printed as a
 * sanity check.
 *
 * Usage: node scripts/test-live-cross-service.mjs
 *   Reads the cookie from ./.dashboard-cookie (or $DASHBOARD_COOKIE).
 *   Reads the account id from ./.dashboard-account-id (or $DASHBOARD_ACCOUNT_ID) if present,
 *   otherwise falls back to the account id pasted in chat for this one-off check.
 */
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

const CROSS_SERVICE_URL = 'https://sms.web-core.dashboard.api.sinch.com/graphql';
const OPERATOR_LIST_QUERY =
  'query OperatorList($accountId: String!, $operatorListInput: OperatorListInput) {\n' +
  '  operatorList(accountId: $accountId, operatorListInput: $operatorListInput) {\n' +
  '    id\n    name\n    countryCode\n    __typename\n  }\n}\n';

function readFileFirst(paths, envVar) {
  for (const f of paths) if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return process.env[envVar]?.trim();
}

async function main() {
  const cookie = readFileFirst(['.dashboard-cookie', 'scripts/.dashboard-cookie'], 'DASHBOARD_COOKIE');
  const accountId = readFileFirst(['.dashboard-account-id', 'scripts/.dashboard-account-id'], 'DASHBOARD_ACCOUNT_ID');
  if (!cookie) { console.error('No cookie (./.dashboard-cookie or $DASHBOARD_COOKIE).'); process.exit(2); }
  if (!accountId) { console.error('No account id (./.dashboard-account-id or $DASHBOARD_ACCOUNT_ID).'); process.exit(2); }

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  Object.assign(process.env, {
    ISSUER_URL: 'http://localhost:8080', AUDIENCE: 'http://localhost:9090/mcp',
    SESSION_SECRET: 'cross-service-check', PRIVATE_KEY_PEM: privateKey, OAUTH_CLIENTS: '{}',
    LOGIN_MODE: 'dashboard',
  });
  delete process.env.DASHBOARD_MOCK;

  const dash = await import('../dist/dashboard.js');

  console.log('minting CCP token from cookie alone...');
  const token = await dash.refreshCcpToken(cookie);
  console.log(`✓ got a JWT-shaped token (segments=${token.split('.').length})`);

  console.log(`\ncalling a DIFFERENT service: ${CROSS_SERVICE_URL}`);
  const res = await fetch(CROSS_SERVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      operationName: 'OperatorList',
      variables: { accountId, operatorListInput: { operationalState: 'ACTIVE' } },
      query: OPERATOR_LIST_QUERY,
    }),
  });
  console.log(`  HTTP ${res.status}`);
  if (!res.ok) {
    console.error(`✗ FAILED: cross-service call rejected the token (HTTP ${res.status})`);
    process.exit(1);
  }
  const json = await res.json();
  if (json.errors?.length) {
    console.error(`✗ FAILED: GraphQL error: ${json.errors[0].message}`);
    process.exit(1);
  }
  const operators = json.data?.operatorList ?? [];
  console.log(`✓ operatorList returned ${operators.length} operator(s)`);
  for (const o of operators.slice(0, 3)) {
    console.log(`    - ${o.name} (${o.countryCode})`);
  }

  console.log('\n✅ CROSS-SERVICE TOKEN CHECK PASSED — the cookie-minted CCP token works as a');
  console.log('   general-purpose Bearer across dashboard microservices, not just dashboard.api.sinch.com.');
}

main().catch((err) => { console.error(`\n✗ FAILED: ${err.message}`); process.exit(1); });
