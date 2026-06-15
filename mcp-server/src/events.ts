import { config } from './config.js';

export function isEventsConfigured(): boolean {
  return !!config.eventsApiUrl;
}

async function eventsGet(path: string): Promise<unknown> {
  if (!config.eventsApiUrl) throw new Error('EVENTS_API_URL is not configured');
  const url = `${config.eventsApiUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {};
  if (config.eventsApiKey) headers['Authorization'] = `Bearer ${config.eventsApiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Events API ${res.status}: ${await res.text()}`);
  return res.json();
}

export function getEventsByMessageId(messageId: string): Promise<unknown> {
  return eventsGet(`/events?messageId=${encodeURIComponent(messageId)}`);
}

export function getEventsByRange(from: string, to: string): Promise<unknown> {
  return eventsGet(`/events/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}
