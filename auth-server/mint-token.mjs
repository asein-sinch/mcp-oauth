// Mint a JWT for testing the MCP server (same claims the /token endpoint issues), without the
// browser OAuth dance. Pure JS (uses jose from node_modules).
//
//   node mint-token.mjs [env-file] [email]
//
// Config is read from process.env, so inside a container you can do:
//   docker run --rm --env-file auth.env <auth-image> node mint-token.mjs [email]
// Locally, pass an env file as the first arg and it is loaded first:
//   node mint-token.mjs /tmp/auth-real.env [email]
// Needs PRIVATE_KEY_PEM, ISSUER_URL, AUDIENCE, KEY_ID, ACCESS_TOKEN_TTL, USERS. [email] defaults
// to the first user in USERS. Set SUBPROJECT_ID to override the subproject_id claim.
import { existsSync, readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';

const args = process.argv.slice(2);
let email;
if (args[0] && existsSync(args[0])) {
  // First arg is an env file — load it into process.env (without overriding what's already set).
  for (const line of readFileSync(args[0], 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    let v = line.slice(i + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    const k = line.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
  email = args[1];
} else {
  email = args[0];
}

const env = process.env;
const pem = (env.PRIVATE_KEY_PEM ?? '').replace(/\\n/g, '\n');
const issuer = (env.ISSUER_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const audience = env.AUDIENCE ?? 'http://localhost:8090/mcp';
const keyId = env.KEY_ID ?? 'demo-key-1';
const ttl = Number(env.ACCESS_TOKEN_TTL ?? 3600);
const users = JSON.parse(env.USERS ?? '{}');
email = email ?? Object.keys(users)[0];
const subprojectId = process.env.SUBPROJECT_ID ?? users[email]?.subprojectId;

if (!pem) { console.error('PRIVATE_KEY_PEM missing in env file'); process.exit(1); }
if (!subprojectId) { console.error(`no subproject_id for "${email}" (set SUBPROJECT_ID or add to USERS)`); process.exit(1); }

const key = await importPKCS8(pem, 'RS256');
const now = Math.floor(Date.now() / 1000);
const jwt = await new SignJWT({ subproject_id: subprojectId, scope: 'sinch' })
  .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
  .setIssuer(issuer)
  .setSubject(email)
  .setAudience(audience)
  .setIssuedAt(now)
  .setExpirationTime(now + ttl)
  .sign(key);

console.log(jwt);
