import type { Request, Response } from 'express';
import { config } from '../config.js';
import { getJwks, SIGNING_ALG } from '../keys.js';

/** Public JWK Set — how the MCP server verifies token signatures. */
export function handleJwks(_req: Request, res: Response): void {
  res.json(getJwks());
}

/** OAuth 2.0 Authorization Server Metadata (RFC 8414). Optional but handy for tooling. */
export function handleAsMetadata(_req: Request, res: Response): void {
  res.json({
    issuer: config.issuerUrl,
    authorization_endpoint: `${config.issuerUrl}/authorize`,
    token_endpoint: `${config.issuerUrl}/token`,
    jwks_uri: `${config.issuerUrl}/.well-known/jwks.json`,
    registration_endpoint: `${config.issuerUrl}/register`,
    device_authorization_endpoint: `${config.issuerUrl}/device_authorization`,
    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'urn:ietf:params:oauth:grant-type:device_code',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    id_token_signing_alg_values_supported: [SIGNING_ALG],
  });
}
