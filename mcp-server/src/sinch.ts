import { config, type SinchCredentials } from './config.js';

/**
 * Thin Sinch API client. Exchanges the subproject's access key/secret for an OAuth2
 * access token (client_credentials), then calls a Sinch API on behalf of that subproject.
 *
 * Tokens are cached in-memory per subproject until shortly before they expire.
 */

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(subprojectId: string, creds: SinchCredentials): Promise<string> {
  const cached = tokenCache.get(subprojectId);
  if (cached && Date.now() < cached.expiresAt - 30_000) return cached.token;

  const basic = Buffer.from(`${creds.accessKey}:${creds.accessSecret}`).toString('base64');
  const res = await fetch(config.sinchAuthUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    throw new Error(`Sinch token request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  tokenCache.set(subprojectId, { token: json.access_token, expiresAt });
  return json.access_token;
}

/** Example read-only call: list active phone numbers for the subproject (= Sinch project). */
export async function listActiveNumbers(
  subprojectId: string,
  creds: SinchCredentials,
  pageSize = 10,
): Promise<unknown> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `${config.sinchNumbersBase}/v1/projects/${encodeURIComponent(subprojectId)}/activeNumbers?pageSize=${pageSize}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Sinch activeNumbers failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Generic call against the Provisioning API for a subproject (= Sinch projectId).
 * `path` is appended after `/v1/projects/{projectId}`. Returns parsed JSON ({} if empty).
 */
async function provisioningRequest(
  subprojectId: string,
  creds: SinchCredentials,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `${config.sinchProvisioningBase}/v1/projects/${encodeURIComponent(subprojectId)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Sinch provisioning ${method} ${path} failed (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Create an RCS sender. `body` is the full create payload (see rcsSenderTemplate). */
export function createRcsSender(
  subprojectId: string,
  creds: SinchCredentials,
  body: unknown,
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'POST', '/rcs/senders', body);
}

/** Set the target countries on an existing sender (PATCH details.countries). */
export function setRcsSenderCountries(
  subprojectId: string,
  creds: SinchCredentials,
  senderId: string,
  countries: string[],
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'PATCH', `/rcs/senders/${encodeURIComponent(senderId)}`, {
    details: { countries },
  });
}

/** Add test numbers (E.164) to a sender; each tester receives an invite. */
export function addRcsTestNumbers(
  subprojectId: string,
  creds: SinchCredentials,
  senderId: string,
  testNumbers: string[],
): Promise<unknown> {
  return provisioningRequest(
    subprojectId,
    creds,
    'POST',
    `/rcs/senders/${encodeURIComponent(senderId)}/testNumbers`,
    { testNumbers },
  );
}

/** Begin the launch process for a sender (no request body). */
export function launchRcsSender(
  subprojectId: string,
  creds: SinchCredentials,
  senderId: string,
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'POST', `/rcs/senders/${encodeURIComponent(senderId)}/launch`);
}

// --- Conversation API (send messages) ---

interface ConversationApp {
  id: string;
  display_name?: string;
  channel_credentials?: { channel: string }[];
}

/** List Conversation API apps for the subproject (= Sinch projectId). */
async function listConversationApps(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
): Promise<ConversationApp[]> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/apps`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Sinch list apps failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { apps?: ConversationApp[] };
  return data.apps ?? [];
}

const rcsAppCache = new Map<string, string>();

/** Find (and cache) the Conversation app whose channel_credentials include RCS. */
export async function findRcsAppId(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
): Promise<string | null> {
  const cacheKey = `${subprojectId}:${region}`;
  const cached = rcsAppCache.get(cacheKey);
  if (cached) return cached;
  const apps = await listConversationApps(subprojectId, creds, region);
  const app = apps.find((a) => (a.channel_credentials ?? []).some((c) => c.channel === 'RCS'));
  if (app?.id) {
    rcsAppCache.set(cacheKey, app.id);
    return app.id;
  }
  return null;
}

/** Send a message via the Conversation API (messages:send). */
export async function sendConversationMessage(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
  body: unknown,
): Promise<unknown> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/messages:send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Sinch conversation send failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
