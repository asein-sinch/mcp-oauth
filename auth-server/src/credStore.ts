import { nanoid } from 'nanoid';
import { config } from './config.js';
import { deleteAccessKeyQuietly, type AccessKey } from './dashboard.js';

/**
 * Server-side credential store for the back-channel token exchange. The client JWT carries only
 * an opaque `cred_ref`; the sensitive material (the user's personal dashboard JWT, the minted
 * access key, the cached Sinch M2M token) lives here and is never exposed to the MCP client.
 *
 * Keyed by cred_ref. TTL slightly outlives the issued client token so exchanges work for the
 * whole token lifetime. On eviction we best-effort delete the access key we created (10-key cap).
 */

export interface CredRecord {
  dashboardJwt: string;
  dashboardCookie?: string;
  projectId: string;
  accountId?: string;
  email?: string;
  cachedKey?: AccessKey;
  cachedToken?: { token: string; expiresAt: number }; // Sinch M2M token
  expiresAt: number;
}

const creds = new Map<string, CredRecord>();

function ttlMs(): number {
  return (config.accessTokenTtl + 600) * 1000; // token life + 10 min buffer
}

export function putCred(record: Omit<CredRecord, 'expiresAt'>): string {
  const credRef = nanoid(32);
  creds.set(credRef, { ...record, expiresAt: Date.now() + ttlMs() });
  return credRef;
}

export function getCred(credRef: string | undefined | null): CredRecord | null {
  if (!credRef) return null;
  const r = creds.get(credRef);
  if (!r) return null;
  if (Date.now() > r.expiresAt) {
    evict(credRef, r);
    return null;
  }
  return r;
}

export function updateCred(credRef: string, patch: Partial<Omit<CredRecord, 'expiresAt'>>): void {
  const r = creds.get(credRef);
  if (!r) return;
  Object.assign(r, patch);
}

function evict(credRef: string, r: CredRecord): void {
  creds.delete(credRef);
  if (r.cachedKey && r.accountId) {
    void deleteAccessKeyQuietly(
      { token: r.dashboardJwt, cookie: r.dashboardCookie },
      r.accountId,
      r.cachedKey.accessKeyId,
    );
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [credRef, r] of creds) {
    if (now > r.expiresAt) evict(credRef, r);
  }
}, 60_000).unref();
