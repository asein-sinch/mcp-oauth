import { config } from './config.js';

/**
 * Talks to the Sinch Customer Dashboard, authorized by the user's pasted CCP bearer token
 * (iss: "CCP", ~48h lifetime) plus, where required, their dashboard session cookie. After the
 * credentials, everything is a call to dashboard.api.sinch.com:
 *  - accounts:      GET  /api/v1/me                    (REST)
 *  - projects:      POST /graphql  ListParentProjects  (GraphQL)
 *  - access keys:   POST /graphql  ListAccessKeys / CreateAccessKey / DeleteAccessKey (GraphQL)
 * All GraphQL operations were captured from the real dashboard.
 *
 * When `config.dashboardMock` is set, every function returns fixtures so the wizard + token
 * exchange can be built/tested without a real token.
 */

/** The per-user dashboard credentials: the CCP bearer token and (optionally) the session cookie. */
export interface DashboardCreds {
  token: string;
  cookie?: string;
}

export interface Account {
  id: string;
  name: string;
}
export interface Project {
  id: string;
  name: string;
  accountId?: string;
}
export interface AccessKey {
  accessKeyId: string;
  accessKeySecret: string;
}

const MOCK = config.dashboardMock;
// REST base is the GraphQL URL without the trailing /graphql (e.g. https://dashboard.api.sinch.com).
const API_BASE = config.dashboardGraphqlUrl.replace(/\/graphql\/?$/, '');

/** Authorization + optional Cookie headers for every dashboard call. */
function authHeaders(creds: DashboardCreds): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${creds.token}` };
  if (creds.cookie) h.Cookie = creds.cookie;
  return h;
}

// ── token sanity check (NOT signature verification — we don't hold CCP's key) ──
/** Decode the pasted token's payload and check it looks like a live CCP token. */
export function inspectDashboardToken(token: string): { valid: boolean; sub?: string; reason?: string } {
  if (MOCK) return { valid: token.length > 0, sub: 'demo@sinch.com', reason: token ? undefined : 'empty token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'not a JWT' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'unreadable token payload' };
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
    return { valid: false, reason: 'token has expired — grab a fresh one from the dashboard' };
  }
  return { valid: true, sub: typeof payload.sub === 'string' ? payload.sub : undefined };
}

// ── GraphQL transport ─────────────────────────────────────────────────────────
async function gql<T>(
  creds: DashboardCreds,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(config.dashboardGraphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(creds) },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) throw new Error(`dashboard GraphQL ${operationName} HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`dashboard GraphQL ${operationName}: ${json.errors[0].message}`);
  if (!json.data) throw new Error(`dashboard GraphQL ${operationName}: empty data`);
  return json.data;
}

/** A GraphQL mutation response envelope (ok/message/errors) shared by the dashboard mutations. */
interface MutationResponse {
  ok?: boolean;
  message?: string;
  errors?: { field?: string; errors?: string[] }[];
}
function assertMutationOk(op: string, r: MutationResponse | undefined): void {
  if (r && r.ok === false) throw new Error(`${op} failed: ${r.message ?? JSON.stringify(r.errors ?? [])}`);
}

// ── accounts (REST: GET /api/v1/me) ────────────────────────────────────────────
export async function listAccounts(creds: DashboardCreds): Promise<Account[]> {
  if (MOCK) return [{ id: 'acc_demo', name: 'Demo Corporation' }];

  const res = await fetch(`${API_BASE}/api/v1/me`, {
    headers: { Accept: 'application/json', ...authHeaders(creds) },
  });
  if (!res.ok) throw new Error(`dashboard /api/v1/me HTTP ${res.status}`);
  const me = (await res.json()) as Record<string, unknown>;
  const accounts = extractAccounts(me);
  if (accounts.length === 0) {
    // Self-diagnosing: surface the response's key names (never values) so we can pin the shape.
    const data = (me.data && typeof me.data === 'object' ? (me.data as Record<string, unknown>) : me);
    throw new Error(`no accounts found in /api/v1/me — top-level keys: [${Object.keys(data).join(', ')}]`);
  }
  return accounts;
}

/** Pull the account list out of /me across a few likely shapes (confirmed/relaxed from capture). */
function extractAccounts(me: Record<string, unknown>): Account[] {
  const norm = (raw: unknown): Account | null => {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const acc = (o.account && typeof o.account === 'object' ? (o.account as Record<string, unknown>) : o);
    const id = acc.id ?? acc.accountId ?? acc.account_id;
    const name = acc.displayName ?? acc.name ?? acc.display_name ?? id;
    return typeof id === 'string' && id ? { id, name: String(name) } : null;
  };
  const data = (me.data && typeof me.data === 'object' ? (me.data as Record<string, unknown>) : me);
  for (const key of ['accounts', 'memberships', 'accountMemberships']) {
    const bucket = data[key];
    if (Array.isArray(bucket)) {
      const accounts = bucket.map(norm).filter((a): a is Account => a !== null);
      if (accounts.length) return accounts;
    }
  }
  // Single-account shapes: { account: {...} } or a flat account object.
  const single = norm(data.account) ?? norm(data);
  return single ? [single] : [];
}

// ── projects (GraphQL: ListParentProjects) ─────────────────────────────────────
export async function listProjects(creds: DashboardCreds, accountId: string): Promise<Project[]> {
  if (MOCK) return [{ id: 'proj_demo', name: 'Demo Project', accountId }];

  const query =
    `query ListParentProjects($accountId: String!, $includeMetadata: Boolean, $pageSize: Int, $pageToken: String) {\n` +
    `  listParentProjects(accountId: $accountId, includeMetadata: $includeMetadata, pageSize: $pageSize, pageToken: $pageToken) {\n` +
    `    projects { projectId displayName __typename }\n    nextPageToken\n    __typename\n  }\n}`;

  const projects: Project[] = [];
  let pageToken: string | undefined;
  do {
    const data = await gql<{ listParentProjects?: { projects?: { projectId: string; displayName?: string }[]; nextPageToken?: string } }>(
      creds, 'ListParentProjects', query,
      { accountId, includeMetadata: true, pageSize: 50, pageToken },
    );
    const page = data.listParentProjects;
    for (const p of page?.projects ?? []) {
      if (p.projectId) projects.push({ id: p.projectId, name: p.displayName ?? p.projectId, accountId });
    }
    pageToken = page?.nextPageToken || undefined;
  } while (pageToken);
  return projects;
}

// ── access keys (GraphQL) ───────────────────────────────────────────────────────
interface ExistingKey { id: string; displayName?: string }

async function listAccessKeys(creds: DashboardCreds, accountId: string, projectId: string): Promise<ExistingKey[]> {
  const query =
    `query ListAccessKeys($accountId: String!, $projectId: String!) {\n` +
    `  listAccessKeys(accountId: $accountId, projectId: $projectId) {\n` +
    `    id\n    displayName\n    projectId\n    createdAt\n    __typename\n  }\n}`;
  const data = await gql<{ listAccessKeys?: ExistingKey[] }>(creds, 'ListAccessKeys', query, { accountId, projectId });
  return data.listAccessKeys ?? [];
}

async function deleteAccessKey(creds: DashboardCreds, accountId: string, accessKeyId: string): Promise<void> {
  const query =
    `mutation DeleteAccessKey($accountId: String!, $accessKeyId: String!) {\n` +
    `  deleteAccessKey(accountId: $accountId, accessKeyId: $accessKeyId) {\n    ok\n    message\n    errors { field errors __typename }\n    __typename\n  }\n}`;
  const data = await gql<{ deleteAccessKey?: MutationResponse }>(creds, 'DeleteAccessKey', query, { accountId, accessKeyId });
  assertMutationOk('DeleteAccessKey', data.deleteAccessKey);
}

/**
 * Reuse-or-recreate by display name: delete any existing key named ACCESS_KEY_DISPLAY_NAME (frees
 * a slot toward the 10-key cap), then create a fresh one. The one-time secret is returned only here
 * (createAccessKey.secret) — ListAccessKeys never exposes it.
 */
export async function ensureFreshAccessKey(creds: DashboardCreds, accountId: string, projectId: string): Promise<AccessKey> {
  if (MOCK) return { accessKeyId: `mockkey_${projectId}`, accessKeySecret: 'mock-secret' };

  const displayName = config.accessKeyDisplayName;
  try {
    const existing = await listAccessKeys(creds, accountId, projectId);
    await Promise.all(
      existing.filter((k) => k.displayName === displayName).map((k) => deleteAccessKey(creds, accountId, k.id)),
    );
  } catch {
    // best-effort cleanup; if it fails we still try to create (and may hit the cap).
  }

  const query =
    `mutation CreateAccessKey($accountId: String!, $projectId: String!, $displayName: String!) {\n` +
    `  createAccessKey(accountId: $accountId, projectId: $projectId, displayName: $displayName) {\n` +
    `    accessKey { id displayName projectId createdAt __typename }\n    secret\n    ok\n    message\n    errors { field errors __typename }\n    __typename\n  }\n}`;
  const data = await gql<{
    createAccessKey?: MutationResponse & { accessKey?: { id?: string }; secret?: string };
  }>(creds, 'CreateAccessKey', query, { accountId, projectId, displayName });

  const created = data.createAccessKey;
  assertMutationOk('CreateAccessKey', created);
  const accessKeyId = created?.accessKey?.id;
  const accessKeySecret = created?.secret;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('CreateAccessKey returned no id/secret');
  }
  return { accessKeyId, accessKeySecret };
}

/** Best-effort cleanup of a created key (called on cred-ref expiry). */
export async function deleteAccessKeyQuietly(creds: DashboardCreds, accountId: string, accessKeyId: string): Promise<void> {
  if (MOCK) return;
  try {
    await deleteAccessKey(creds, accountId, accessKeyId);
  } catch {
    /* best-effort */
  }
}

// ── Sinch M2M token (client_credentials with the minted access key) ────────────
export async function clientCredentialsToken(
  key: AccessKey,
): Promise<{ accessToken: string; expiresIn: number }> {
  if (MOCK) return { accessToken: `mock-sinch-token:${key.accessKeyId}`, expiresIn: 3600 };

  const basic = Buffer.from(`${key.accessKeyId}:${key.accessKeySecret}`).toString('base64');
  const res = await fetch(config.sinchAuthUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Sinch client_credentials failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}
