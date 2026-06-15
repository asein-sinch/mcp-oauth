import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { authenticate } from './auth.js';
import { createMcpServer } from './tools.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

// MCP endpoint (StreamableHTTP, stateless). Gemini requires StreamableHTTP — no SSE.
// `authenticate` resolves identity + Sinch credentials per AUTH_MODE first.
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

// Stateless server: no GET SSE stream or DELETE session teardown.
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[mcp-server] listening on :${config.port} (AUTH_MODE=${config.authMode})`);
});
