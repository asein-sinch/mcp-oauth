import { importPKCS8, importJWK, exportJWK, type JWK, type KeyLike } from 'jose';
import { config } from './config.js';

/**
 * Loads the RSA private key (for signing) and derives the public JWK (for the JWKS endpoint).
 * The private key never leaves this service; only the public JWK is published.
 */

const ALG = 'RS256';

let privateKey: KeyLike;
let publicKey: KeyLike; // for verifying tokens WE issued (token-exchange subject_token)
let publicJwk: JWK;

export async function loadKeys(): Promise<void> {
  privateKey = await importPKCS8(config.privateKeyPem, ALG);
  // exportJWK on the private key yields all components; strip private fields for the public JWK.
  const full = await exportJWK(privateKey);
  publicJwk = {
    kty: full.kty,
    n: full.n,
    e: full.e,
    alg: ALG,
    use: 'sig',
    kid: config.keyId,
  };
  publicKey = (await importJWK(publicJwk, ALG)) as KeyLike;
}

export function getPrivateKey(): KeyLike {
  if (!privateKey) throw new Error('keys not loaded — call loadKeys() at startup');
  return privateKey;
}

/** Public key for verifying access tokens this server issued (used by the token-exchange grant). */
export function getVerificationKey(): KeyLike {
  if (!publicKey) throw new Error('keys not loaded — call loadKeys() at startup');
  return publicKey;
}

export function getJwks(): { keys: JWK[] } {
  if (!publicJwk) throw new Error('keys not loaded — call loadKeys() at startup');
  return { keys: [publicJwk] };
}

export const SIGNING_ALG = ALG;
