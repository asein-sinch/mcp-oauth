import { nanoid } from 'nanoid';
import type { AuthorizeParams } from './authorize.js';
import type { Account, Project } from '../dashboard.js';

/**
 * Server-side state for the multi-step dashboard login wizard, keyed by an opaque `sid` that
 * lives in the (signed, http-only) cookie session. Sensitive material — the personal dashboard
 * JWT — stays here on the server and never goes into the cookie or any client-visible field.
 *
 * In-memory + TTL, single-instance only (same trade-off as store.ts / deviceStore.ts).
 */

export type WizardStage = 'token' | 'account' | 'project';

export interface LoginSession {
  params: AuthorizeParams; // the in-flight OAuth authorize request
  stage: WizardStage;
  email?: string; // the `sub` from the pasted dashboard token
  dashboardJwt?: string; // the pasted CCP bearer token
  dashboardCookie?: string; // the pasted dashboard session cookie (if required)
  accounts?: Account[];
  accountId?: string;
  projects?: Project[];
  expiresAt: number;
}

const TTL_MS = 15 * 60_000; // the whole wizard must complete within 15 minutes
const sessions = new Map<string, LoginSession>();

export function createSession(params: AuthorizeParams): string {
  const sid = nanoid(32);
  sessions.set(sid, { params, stage: 'token', expiresAt: Date.now() + TTL_MS });
  return sid;
}

export function getSession(sid: string | undefined | null): LoginSession | null {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return s;
}

export function updateSession(sid: string, patch: Partial<Omit<LoginSession, 'expiresAt'>>): void {
  const s = sessions.get(sid);
  if (!s) return;
  Object.assign(s, patch);
}

export function deleteSession(sid: string): void {
  sessions.delete(sid);
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(sid);
  }
}, 60_000).unref();
