import { createHash } from 'node:crypto';

/**
 * PKCE (RFC 7636) S256 verification.
 * challenge == BASE64URL(SHA256(verifier))
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return timingSafeEqualStr(computed, challenge);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
