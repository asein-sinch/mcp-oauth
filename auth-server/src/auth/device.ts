import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { verifyCredentials } from '../users.js';
import { storeDeviceCode, generateUserCode, getByUserCode, authorizeDevice } from './deviceStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEVICE_TEMPLATE = readFileSync(join(__dirname, '..', 'views', 'device.html'), 'utf8');

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDevice(opts: { error?: string; prefilled?: string }): string {
  return DEVICE_TEMPLATE
    .replace('{{ERROR}}', opts.error ? `<div class="error">${esc(opts.error)}</div>` : '')
    .replace('{{PREFILLED_CODE}}', esc(opts.prefilled ?? ''));
}

/**
 * POST /device_authorization
 * Called by the agent to start the device authorization flow.
 * Returns: device_code, user_code, verification_uri, expires_in, interval.
 */
export function handleDeviceAuthorization(req: Request, res: Response): void {
  const body = req.body as Record<string, unknown>;
  const clientId = String(body.client_id ?? '');
  const client = config.clients[clientId];

  if (!client) {
    res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
    return;
  }

  const deviceCode = nanoid(48);
  const userCode = generateUserCode();
  const scope = String(body.scope ?? '');

  storeDeviceCode(deviceCode, { userCode, clientId, scope, status: 'pending' });

  res.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${config.issuerUrl}/device`,
    verification_uri_complete: `${config.issuerUrl}/device?user_code=${encodeURIComponent(userCode)}`,
    expires_in: 600,
    interval: 5,
  });
}

/** GET /device — show the login form for the user to enter their code + credentials. */
export function handleDeviceGetPage(req: Request, res: Response): void {
  const prefilled = String(req.query.user_code ?? '');
  res.type('html').send(renderDevice({ prefilled }));
}

/** POST /device — user submits user_code + credentials. */
export async function handleDevicePost(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const userCode = String(body.user_code ?? '').trim().toUpperCase();
  const email = String(body.email ?? '');
  const password = String(body.password ?? '');

  const record = getByUserCode(userCode);
  if (!record) {
    res.status(400).type('html').send(renderDevice({
      error: 'Code not found or expired. Please restart the authorization in Gemini Enterprise.',
      prefilled: userCode,
    }));
    return;
  }

  const user = await verifyCredentials(email, password);
  if (!user) {
    res.status(401).type('html').send(renderDevice({
      error: 'Invalid email or password.',
      prefilled: userCode,
    }));
    return;
  }

  authorizeDevice(userCode, user.email, user.subprojectId);

  // Success page — user closes this tab and returns to GE.
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Connected · Sinch</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin:0; min-height:100vh; display:grid; place-items:center;
           font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
           background:#0b0d12; color:#e7e9ee; }
    .card { width:360px; max-width:calc(100vw - 32px); background:#151922;
            border:1px solid #232838; border-radius:14px; padding:32px 26px;
            box-shadow:0 12px 40px rgba(0,0,0,.45); text-align:center; }
    .icon { font-size:52px; margin-bottom:16px; }
    h2 { margin:0 0 10px; font-size:22px; }
    p { color:#9aa3b2; font-size:14px; line-height:1.6; margin:0 0 8px; }
    .foot { margin-top:20px; font-size:11px; color:#6b7385; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h2>Connected!</h2>
    <p>Your Sinch account <strong>${esc(user.email)}</strong> is now linked to the agent.</p>
    <p>Return to your Gemini Enterprise chat window and continue.</p>
    <p class="foot">You can close this tab.</p>
  </div>
</body>
</html>`);
}
