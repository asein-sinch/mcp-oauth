import crypto from 'node:crypto';
import type { Request, Response } from 'express';

// Dynamic clients are public clients (no secret). PKCE provides the token-exchange security.
interface DynamicClient { redirectUris: string[] }
const dynamicClients = new Map<string, DynamicClient>();

export function getDynamicClient(id: string): DynamicClient | undefined {
  return dynamicClients.get(id);
}

/** POST /register — RFC 7591 Dynamic Client Registration. */
export function handleRegister(req: Request, res: Response): void {
  const uris: unknown = (req.body as Record<string, unknown>)?.redirect_uris;
  if (!Array.isArray(uris) || uris.some(u => typeof u !== 'string')) {
    res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris must be an array of strings',
    });
    return;
  }
  const clientId = crypto.randomUUID();
  dynamicClients.set(clientId, { redirectUris: uris as string[] });
  res.status(201).json({
    client_id: clientId,
    redirect_uris: uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
  });
}
