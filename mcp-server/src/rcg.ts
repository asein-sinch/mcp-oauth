import { config } from './config.js';

/**
 * Client for the Sinch Generative AI Rich Content Generator (RCG) API.
 *
 * Authenticates with Microsoft Entra (client-credentials), creates/continues an RCG
 * conversation, streams the SSE response, and returns the generated RCS canvas template.
 * RCG access is company-wide (Entra creds), independent of the per-subproject Sinch vault.
 */

interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

function entraConfigOrNull(): EntraConfig | null {
  const { tenantId, clientId, clientSecret, scope } = config.entra;
  if (!tenantId || !clientId || !clientSecret || !scope) return null;
  return { tenantId, clientId, clientSecret, scope };
}

/** True when all Entra env vars are present (the tool can run). */
export function isRcgConfigured(): boolean {
  return entraConfigOrNull() !== null;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const entraTokenCache = new Map<string, CachedToken>();

async function getEntraToken(c: EntraConfig): Promise<string> {
  const cacheKey = `${c.tenantId}:${c.clientId}:${c.scope}`;
  const cached = entraTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    scope: c.scope,
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Entra token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  entraTokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  });
  return data.access_token;
}

interface SseResult {
  events: { event: string; data: unknown }[];
  finalResponse: any;
  errorEvent: any;
}

/** Minimal SSE reader: collects events and surfaces the `final_response` / `error` ones. */
async function streamRcgSse(response: Response): Promise<SseResult> {
  if (!response.body) throw new Error('RCG response has no body to stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let currentEvent = 'message';
  let currentData: string[] = [];
  const events: { event: string; data: unknown }[] = [];
  let finalResponse: any = null;
  let errorEvent: any = null;

  const dispatch = () => {
    if (currentData.length === 0 && currentEvent === 'message') return;
    const dataStr = currentData.join('\n');
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      parsed = dataStr;
    }
    events.push({ event: currentEvent, data: parsed });
    if (currentEvent === 'final_response') finalResponse = parsed;
    if (currentEvent === 'error') errorEvent = parsed;
    currentEvent = 'message';
    currentData = [];
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trimStart();
      } else if (line.startsWith('data:')) {
        currentData.push(line.slice(5).trimStart());
      }
    }
  }
  if (buffer.length > 0) {
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer !== '') currentData.push(buffer);
  }
  dispatch();
  return { events, finalResponse, errorEvent };
}

export interface GenerateRcsOptions {
  description: string;
  conversationId?: string;
  flavorId?: string;
  baseUrl?: string;
}

export interface GenerateRcsResult {
  success: true;
  conversationId: string;
  flavorId: string;
  template: unknown;
  canvas: unknown;
}

/** Generate (or refine) an RCS rich message via RCG and return the canvas template. */
export async function generateRcsMessage(opts: GenerateRcsOptions): Promise<GenerateRcsResult> {
  const c = entraConfigOrNull();
  if (!c) {
    throw new Error('Missing Entra config: set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and ENTRA_SCOPE.');
  }
  const baseUrl = (opts.baseUrl || config.rcgBaseUrl).replace(/\/+$/, '');
  const flavorId = opts.flavorId || 'rcs';
  const token = await getEntraToken(c);

  // 1. Create a conversation if one wasn't supplied for refinement.
  let conversationId = opts.conversationId;
  if (!conversationId) {
    const createRes = await fetch(`${baseUrl}/rich_content_generator/v1/conversations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ flavor_id: flavorId }),
    });
    if (!createRes.ok) {
      throw new Error(`Create conversation failed: ${createRes.status} ${await createRes.text()}`);
    }
    const location = createRes.headers.get('location');
    if (location) {
      conversationId = location.split('/').pop() ?? undefined;
    } else {
      // Fallback: list the most recent conversation if no Location header was returned.
      const listRes = await fetch(`${baseUrl}/rich_content_generator/v1/conversations?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (listRes.ok) {
        const list = (await listRes.json()) as { id?: string }[];
        if (Array.isArray(list) && list.length > 0) conversationId = list[0].id;
      }
    }
    if (!conversationId) {
      throw new Error('Conversation created but no ID could be obtained from the Location header or list fallback.');
    }
  }

  // 2. Post the natural-language description and stream the SSE response.
  const msgRes = await fetch(
    `${baseUrl}/rich_content_generator/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ role: 'user', content: opts.description }),
    },
  );
  if (!msgRes.ok) {
    throw new Error(`Send message failed: ${msgRes.status} ${await msgRes.text()}`);
  }

  const parsed = await streamRcgSse(msgRes);
  if (parsed.errorEvent) {
    throw new Error(`RCG returned an error event: ${JSON.stringify(parsed.errorEvent)}`);
  }

  const assistantMessage = parsed.finalResponse?.assistant_message;
  const canvas = assistantMessage?.canvas;
  const template = canvas?.template;

  return {
    success: true,
    conversationId,
    flavorId,
    template: template ?? null,
    canvas: canvas ?? null,
  };
}
