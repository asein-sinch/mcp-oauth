import express from 'express';
import cookieSession from 'cookie-session';
import { config } from './config.js';
import { loadKeys } from './keys.js';
import { handleAuthorize } from './auth/authorize.js';
import { handleLogin } from './auth/login.js';
import { handleToken } from './auth/token.js';
import { handleJwks, handleAsMetadata } from './auth/metadata.js';

async function main(): Promise<void> {
  await loadKeys();

  const app = express();
  // Behind Sliplane's TLS-terminating proxy: trust X-Forwarded-* so secure cookies work.
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(
    cookieSession({
      name: 'sid',
      secret: config.sessionSecret,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    }),
  );

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  // OAuth metadata + JWKS (how the MCP server verifies tokens).
  app.get('/.well-known/jwks.json', handleJwks);
  app.get('/.well-known/oauth-authorization-server', handleAsMetadata);

  // Authorization-code flow.
  app.get('/authorize', handleAuthorize);
  app.get('/login', handleAuthorize); // same query contract; re-renders the form
  app.post('/login', handleLogin);
  app.post('/token', handleToken);

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[auth-server] listening on :${config.port} (issuer ${config.issuerUrl})`);
  });
}

main().catch((err) => {
  console.error('[auth-server] fatal:', err);
  process.exit(1);
});
