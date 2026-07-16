import type { Request, Response, NextFunction } from 'express';

/**
 * Logs everything observable about every incoming request — method, path, IP, all headers, and
 * (if the Authorization header looks like a JWT) its decoded header+payload. Used to see exactly
 * what Gemini Enterprise sends to this MCP server while the real OAuth/token-exchange integration
 * is being designed. Temporary debugging instrumentation — not signature verification, not for
 * production use, remove once the shape of Gemini's requests is understood.
 */
export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  const stamp = new Date().toISOString();
  console.log(`\n[req] ${stamp} ${req.method} ${req.originalUrl} from ${req.ip}`);
  console.log('[req] headers:', JSON.stringify(req.headers, null, 2));

  const auth = req.headers.authorization;
  if (!auth) {
    console.log('[req] no Authorization header');
  } else if (!auth.startsWith('Bearer ')) {
    console.log(`[req] Authorization header present but not "Bearer ...": ${auth.slice(0, 20)}...`);
  } else {
    const token = auth.slice('Bearer '.length);
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.log(`[req] bearer token is opaque (${parts.length} segment(s), not a JWT), length=${token.length}`);
    } else {
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        console.log('[req] bearer token looks like a JWT — decoded (NOT signature-verified):');
        console.log('[req]   header:', JSON.stringify(header));
        console.log('[req]   payload:', JSON.stringify(payload));
      } catch {
        console.log('[req] bearer token has 3 segments but did not decode as base64url JSON (opaque or malformed)');
      }
    }
  }
  next();
}

/** Mount after express.json() — logs the parsed body, since requestLogger runs before parsing. */
export function requestBodyLogger(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && Object.keys(req.body as object).length > 0) {
    console.log('[req] body:', JSON.stringify(req.body, null, 2));
  } else {
    console.log('[req] body: (empty)');
  }
  next();
}

/** Mount last (after routes would normally run) — logs status + latency to correlate with the request. */
export function responseLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}
