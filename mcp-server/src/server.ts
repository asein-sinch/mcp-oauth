import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authenticate } from './auth.js';
import { createMcpServer } from './tools.js';
import { requestLogger, requestBodyLogger, responseLogger } from './requestLogger.js';

import path from 'path';
import fs from 'fs';

const app = express();
app.set('trust proxy', 1);
// Logs everything about every request (headers, decoded bearer token, body) to see exactly what
// Gemini Enterprise sends. Mounted first so it captures requests even if later middleware rejects
// them. Temporary debugging instrumentation — see requestLogger.ts.
app.use(responseLogger);
app.use(requestLogger);
app.use(express.json());
app.use(requestBodyLogger);

// Ensure public/images directory exists
const imagesDir = path.join(process.cwd(), 'public', 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}
app.use('/images', express.static(imagesDir));

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// MCP endpoint (StreamableHTTP, stateless). Gemini requires StreamableHTTP — no SSE.
// `authenticate` binds single-tenant credentials per request.
app.post('/mcp', authenticate, async (req, res) => {
  const server = createMcpServer({
    subprojectId: req.subprojectId!,
    userEmail: req.userEmail,
    creds: req.sinchCreds,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[mcp-server] listening on :${config.port}`);
});
export default app;
export { createMcpServer };
