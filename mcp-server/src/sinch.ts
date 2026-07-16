import { config, type SinchCredentials } from './config.js';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Thin Sinch API client. Exchanges the access key/secret for an OAuth2
 * access token (client_credentials), then calls a Sinch API on behalf of the project.
 *
 * Tokens are cached in-memory.
 */

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedToken>();

// AsyncLocalStorage to carry active tool context from tools.ts down to all outbound HTTP requests
export const toolContextStore = new AsyncLocalStorage<{ toolName: string }>();

// Package version or standard fallback identifier
const MCP_SERVER_VERSION = '0.1.0';

/**
 * Generates the standardized User-Agent header matching Sinch reference:
 * `sinch-sdk/MCP-${mcpServerVersion} (JavaScript/${process.version}; {toolName}; {userId})`
 */
export function getUserAgent(fallbackToolName: string, subprojectId: string): string {
  const toolName = toolContextStore.getStore()?.toolName || fallbackToolName || 'unknown';
  return `sinch-sdk/MCP-${MCP_SERVER_VERSION} (JavaScript/${process.version}; ${toolName}; ${subprojectId})`;
}

/**
 * Helper function to wrap fetch with comprehensive logging for both requests and responses.
 * Since the user is running blind, this outputs highly-detailed trace information to stdout/stderr.
 */
async function fetchWithLogging(
  url: string,
  options: RequestInit,
  contextName: string,
  subprojectId: string,
): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers = options.headers as Record<string, string>;

  console.log(`\n[MCP SINCH REQUEST] [${contextName}] ${method} ${url}`);
  console.log(`[MCP SINCH REQUEST HEADERS]`, JSON.stringify(headers, null, 2));
  if (options.body) {
    console.log(`[MCP SINCH REQUEST BODY]`, typeof options.body === 'string' ? options.body : String(options.body));
  }

  try {
    const res = await fetch(url, options);
    console.log(`[MCP SINCH RESPONSE] [${contextName}] Status: ${res.status} ${res.statusText}`);
    console.log(`[MCP SINCH RESPONSE HEADERS]`, JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));

    // Safely read response text by cloning the response object to preserve streams
    const clonedRes = res.clone();
    const responseText = await clonedRes.text();
    console.log(`[MCP SINCH RESPONSE BODY]`, responseText);

    return res;
  } catch (err) {
    console.error(`[MCP SINCH REQUEST ERROR] [${contextName}]`, err);
    throw err;
  }
}

async function getAccessToken(subprojectId: string, creds: SinchCredentials): Promise<string> {
  const cached = tokenCache.get(subprojectId);
  if (cached && Date.now() < cached.expiresAt - 30_000) return cached.token;

  const basic = Buffer.from(`${creds.accessKey}:${creds.accessSecret}`).toString('base64');
  const res = await fetchWithLogging(
    config.sinchAuthUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getUserAgent('getAccessToken', subprojectId),
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    },
    'getAccessToken',
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch token request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  tokenCache.set(subprojectId, { token: json.access_token, expiresAt });
  return json.access_token;
}

/** Lists active phone numbers for the project. */
export async function listActiveNumbers(
  subprojectId: string,
  creds: SinchCredentials,
  pageSize = 10,
): Promise<unknown> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `${config.sinchNumbersBase}/v1/projects/${encodeURIComponent(subprojectId)}/activeNumbers?pageSize=${pageSize}`;
  const res = await fetchWithLogging(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': getUserAgent('listActiveNumbers', subprojectId),
      },
    },
    'listActiveNumbers',
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch activeNumbers failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Generic call against the Provisioning API.
 * `path` is appended after `/v1/projects/{projectId}`.
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
  const res = await fetchWithLogging(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'User-Agent': getUserAgent('provisioningRequest', subprojectId),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    `provisioning_${method}_${path}`,
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch provisioning ${method} ${path} failed (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/** Create an RCS sender. */
export function createRcsSender(
  subprojectId: string,
  creds: SinchCredentials,
  body: unknown,
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'POST', '/rcs/senders', body);
}

/** Get a specific RCS sender details. */
export function getRcsSender(
  subprojectId: string,
  creds: SinchCredentials,
  senderId: string,
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'GET', `/rcs/senders/${encodeURIComponent(senderId)}`);
}

/** Update fields on an existing RCS sender. */
export function updateRcsSender(
  subprojectId: string,
  creds: SinchCredentials,
  senderId: string,
  body: unknown,
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'PATCH', `/rcs/senders/${encodeURIComponent(senderId)}`, body);
}

/** List RCS senders for the project. */
export async function listRcsSenders(
  subprojectId: string,
  creds: SinchCredentials,
  pageSize = 20,
  pageToken?: string,
): Promise<unknown> {
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (pageToken) params.set('pageToken', pageToken);
  return provisioningRequest(subprojectId, creds, 'GET', `/rcs/senders?${params}`);
}

/** Begin the launch process for an RCS sender. */
export function launchRcsSender(
  subprojectId: string,
  creds: SinchCredentials,
  senderId: string,
): Promise<unknown> {
  return provisioningRequest(subprojectId, creds, 'POST', `/rcs/senders/${encodeURIComponent(senderId)}/launch`);
}

// --- Conversation API (apps, channels and sending messages) ---

export interface ConversationApp {
  id: string;
  display_name?: string;
  channel_credentials?: { channel: string; [key: string]: any }[];
}

/** List Conversation API apps. Region is fixed to server regional env. */
export async function listConversationApps(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
): Promise<ConversationApp[]> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/apps`;
  const res = await fetchWithLogging(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': getUserAgent('listConversationApps', subprojectId),
      },
    },
    'listConversationApps',
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch list apps failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { apps?: ConversationApp[] };
  return data.apps ?? [];
}

/** Create a Conversation API app. */
export async function createConversationApp(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
  displayName: string,
): Promise<ConversationApp> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/apps`;
  const res = await fetchWithLogging(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': getUserAgent('createConversationApp', subprojectId),
      },
      body: JSON.stringify({ display_name: displayName }),
    },
    'createConversationApp',
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch create app failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<ConversationApp>;
}

/** Set/configure a channel credential on a Conversation app, preserving other channels. */
export async function setChannelOnApp(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
  appId: string,
  channelData: { channel: string; [key: string]: any },
): Promise<unknown> {
  const token = await getAccessToken(subprojectId, creds);
  // Get existing app to preserve other credentials
  const getUrl = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/apps/${encodeURIComponent(appId)}`;
  const getRes = await fetchWithLogging(
    getUrl,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': getUserAgent('getConversationApp', subprojectId),
      },
    },
    'getConversationApp',
    subprojectId,
  );
  let existingCreds: any[] = [];
  if (getRes.ok) {
    const appData = (await getRes.json()) as any;
    existingCreds = appData.channel_credentials ?? [];
  }

  // Filter out existing credentials for same channel, append new one
  const updatedCreds = existingCreds.filter((c: any) => c.channel !== channelData.channel);
  updatedCreds.push(channelData);

  const patchUrl = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/apps/${encodeURIComponent(appId)}?updateMask=channel_credentials`;
  const patchRes = await fetchWithLogging(
    patchUrl,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': getUserAgent('setChannelOnApp', subprojectId),
      },
      body: JSON.stringify({
        channel_credentials: updatedCreds,
      }),
    },
    'setChannelOnApp',
    subprojectId,
  );
  if (!patchRes.ok) {
    throw new Error(`Sinch setChannelOnApp failed (${patchRes.status}): ${await patchRes.text()}`);
  }
  return patchRes.json();
}

/** List Conversation templates in the project. */
export async function listTemplates(
  subprojectId: string,
  creds: SinchCredentials,
  region: string,
): Promise<unknown> {
  const token = await getAccessToken(subprojectId, creds);
  const url = `https://${region}.conversation.api.sinch.com/v1/projects/${encodeURIComponent(subprojectId)}/templates`;
  const res = await fetchWithLogging(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': getUserAgent('listTemplates', subprojectId),
      },
    },
    'listTemplates',
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch list templates failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
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
  const res = await fetchWithLogging(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': getUserAgent('sendConversationMessage', subprojectId),
      },
      body: JSON.stringify(body),
    },
    'sendConversationMessage',
    subprojectId,
  );
  if (!res.ok) {
    throw new Error(`Sinch conversation send failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
