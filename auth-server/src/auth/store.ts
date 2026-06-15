/**
 * In-memory, single-use authorization-code store with TTL.
 * Fine for a single-instance demo. For multi-instance you'd back this with Redis.
 */

export interface AuthCodeRecord {
  email: string;
  subprojectId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string; // PKCE S256 challenge
  expiresAt: number; // epoch ms
}

const codes = new Map<string, AuthCodeRecord>();

const TTL_MS = 60_000; // authorization codes are short-lived

export function putCode(code: string, record: Omit<AuthCodeRecord, 'expiresAt'>): void {
  codes.set(code, { ...record, expiresAt: Date.now() + TTL_MS });
}

/** Atomically fetch-and-delete: a code can only be redeemed once. */
export function consumeCode(code: string): AuthCodeRecord | null {
  const record = codes.get(code);
  if (!record) return null;
  codes.delete(code);
  if (Date.now() > record.expiresAt) return null;
  return record;
}

// Periodically drop expired codes so the map does not grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [code, record] of codes) {
    if (now > record.expiresAt) codes.delete(code);
  }
}, 30_000).unref();
