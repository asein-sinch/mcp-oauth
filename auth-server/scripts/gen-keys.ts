/**
 * Generates an RSA key pair for signing JWTs and prints the values you need for the
 * auth server's environment. Run:  npm run gen-keys
 *
 * Copy PRIVATE_KEY_PEM (single-line, \n-escaped) into the auth server's env.
 * The public key is derived automatically and served at /.well-known/jwks.json — you
 * do NOT need to copy it anywhere.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';

const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
const pkcs8 = await exportPKCS8(privateKey);

console.log('# --- add to your auth-server env (.env / Sliplane) ---\n');
console.log('PRIVATE_KEY_PEM=' + JSON.stringify(pkcs8.replace(/\n$/, '')));
console.log('\n# (KEY_ID defaults to "demo-key-1"; override with KEY_ID=... if you like)');
