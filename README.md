# Sinch ↔ Gemini Enterprise MCP demo — auth server + MCP server

A self-hosted OAuth 2.0 identity provider and the MCP server it protects, for demoing a
Sinch MCP server inside a **Gemini Enterprise** agent.

A user signs in, authorizes Gemini to connect to Sinch, and the auth server issues a JWT
carrying a `subproject_id` claim. Gemini passes that JWT to the MCP server, which verifies it
against the auth server's public keys (JWKS), resolves the subproject's Sinch credentials from
a vault, and calls the Sinch API.

```
Gemini Enterprise (OAuth client)
   │  authorization-code + PKCE flow
   ▼
[ auth-server ]  login → /token → signed JWT { subproject_id, sub, aud, … }
   │             publishes public keys at /.well-known/jwks.json
   ▼
Gemini calls the MCP server with  Authorization: Bearer <JWT>
   ▼
[ mcp-server ]   verifies JWT via JWKS → subproject_id → vault → Sinch creds → Sinch API
```

The two services share **nothing secret**: the auth server holds the RSA private key and
signs tokens; the MCP server only fetches the matching **public** key to verify signatures.

| Service | Port | Role |
|---|---|---|
| [`auth-server/`](auth-server) | 8080 | OAuth 2.0 authorization server (login, `/authorize`, `/token`, JWKS) |
| [`mcp-server/`](mcp-server) | 8090 | StreamableHTTP MCP server; verifies the JWT, calls Sinch |

## MCP tools

| Tool | Inputs | What it does |
|---|---|---|
| `whoami` | – | Echoes the subproject + user resolved from the JWT (identity-chain check). |
| `list_active_numbers` | `pageSize?` | Lists active numbers for the subproject (Numbers API). |
| `create_rcs_sender` | `name`, `description` | Creates an RCS sender; brand assets, legal URLs, contact and the FR questionnaire are pre-filled ([`rcsSenderTemplate.ts`](mcp-server/src/rcsSenderTemplate.ts)). Returns the `senderId` + state and suggests countries to add (FR recommended). |
| `add_rcs_sender_countries` | `senderId`, `countries[]` | Sets target countries (ISO 3166-1 alpha-2; validated against the supported set). |
| `add_rcs_test_numbers` | `senderId`, `testNumbers[]` | Adds E.164 tester numbers (each gets an invite). |
| `launch_rcs_sender` | `senderId` | Begins the launch process. |
| `generate-rcs-message` | `description`, `conversationId?`, `flavorId?`, `baseUrl?` | Generates an RCS rich-message canvas via the Sinch Generative AI RCG API ([`rcg.ts`](mcp-server/src/rcg.ts)). Uses **company-wide Entra creds** (`ENTRA_*`), not the per-subproject vault; pass back `conversationId` to refine. |
| `send-rcs-message` | `to`, `message`, `appId?`, `region?` | Sends an RCS message via the Conversation API. Pass the `generate-rcs-message` output as `message`; the tool fills in the recipient and **auto-detects the RCS-enabled Conversation app** for the project (override with `appId`/`CONVERSATION_APP_ID`, region defaults to `eu`). |

RCS onboarding flow the agent walks through: **create_rcs_sender → add_rcs_sender_countries → add_rcs_test_numbers → launch_rcs_sender**. The `senderId` from step 1 is threaded into the later calls by the agent (the server is stateless).

`generate-rcs-message` is an [MCP Apps](https://modelcontextprotocol.io) tool: on hosts that support the extension it renders an interactive phone-mockup preview ([`ui/rcs-preview.html`](mcp-server/ui/rcs-preview.html)); other hosts (incl. Gemini Enterprise) ignore the UI and use the structured text result. The tool and preview only activate when the `ENTRA_*` vars are set.

Messaging flow: **generate-rcs-message → send-rcs-message**. The agent passes the generated `template` straight into `send-rcs-message` as `message`; the send tool only adds the recipient and the auto-detected RCS Conversation app.

## JWT contract

- **Alg:** RS256, signed with the auth server's private key; header carries a `kid`.
- **Claims:** `iss` (auth server URL), `sub` (user email), `aud` (MCP server URL), `iat`,
  `exp`, and **`subproject_id`** (custom claim → keys the MCP server's vault lookup).
- **Verify:** the MCP server uses `jose`'s `createRemoteJWKSet(JWKS_URL)` + `jwtVerify(token,
  JWKS, { issuer, audience })`. The JWKS is fetched once and cached; key rotation = publish a
  new `kid`.

## Local quickstart

### 1. Auth server

```bash
cd auth-server
npm install
npm run gen-keys                              # prints PRIVATE_KEY_PEM=... for your env
npx tsx scripts/hash-password.ts 'demo-pass'  # prints a bcrypt hash for a demo user
cp .env.example .env                          # then fill PRIVATE_KEY_PEM, USERS hashes, etc.
npm run dev                                   # http://localhost:8080
```

`USERS` maps each demo email to a bcrypt password hash **and** the Sinch subproject it should
be associated with — this is what becomes the `subproject_id` claim:

```json
{ "antoine.sein@sinch.com": { "passwordHash": "$2a$10$…", "subprojectId": "subproject-A" },
  "colleague@sinch.com":   { "passwordHash": "$2a$10$…", "subprojectId": "subproject-B" } }
```

### 2. MCP server

```bash
cd mcp-server
npm install
cp .env.example .env   # point JWKS_URL/EXPECTED_ISSUER at the auth server; fill SINCH_CREDENTIALS
npm run dev            # http://localhost:8090
```

`SINCH_CREDENTIALS` is the vault — `subproject_id → { accessKey, accessSecret }` (the Sinch
Build access key/secret for each subproject).

### 3. Verify end-to-end

```bash
node auth-server/run-with-env.mjs auth-server/.env   # or `npm run dev`
node auth-server/flow-test.mjs                        # authorize → login → token → JWKS verify
node mcp-server/mcp-test.mjs                           # mints a JWT, drives the MCP server, 401 path
```

`flow-test.mjs` and `mcp-test.mjs` are throwaway local harnesses that assume the demo
credentials above.

## Docker

```bash
docker build -t sinch-auth-server ./auth-server
docker build -t sinch-mcp-server  ./mcp-server

docker run --env-file auth-server/.env -e NODE_ENV=production -p 8080:8080 sinch-auth-server
docker run --env-file mcp-server/.env  -e NODE_ENV=production -p 8090:8090 sinch-mcp-server
```

Note: Docker's `--env-file` keeps values **literally** — the `PRIVATE_KEY_PEM` value must
**not** be wrapped in quotes in that file (the `\n` escapes are fine; the app un-escapes them).

## Deploy to Sliplane

Create **two** Sliplane services, one per folder (each has its own `Dockerfile`):

1. **auth-server** — set env: `ISSUER_URL` (= the service's own HTTPS domain), `AUDIENCE`
   (= the MCP service's `…/mcp` URL), `PRIVATE_KEY_PEM`, `SESSION_SECRET`, `OAUTH_CLIENTS`,
   `USERS`, `NODE_ENV=production`. Health check `/healthz`.
2. **mcp-server** — set env: `JWKS_URL` (= `<auth-domain>/.well-known/jwks.json`),
   `EXPECTED_ISSUER` (= auth domain), `EXPECTED_AUDIENCE` (= this service's `…/mcp` URL),
   `SINCH_CREDENTIALS`. Health check `/healthz`.

Sliplane terminates TLS and gives each service an HTTPS domain.

## Connect it in Gemini Enterprise

In the **custom MCP server** connector, fill:

| Field | Value |
|---|---|
| Authorization URL | `https://<auth-domain>/authorize` |
| Token URL | `https://<auth-domain>/token` |
| Client ID | the key you used in `OAUTH_CLIENTS` (e.g. `gemini-enterprise`) |
| Client Secret | the matching `clientSecret` |
| Scopes | e.g. `sinch` |
| MCP Server URL | `https://<mcp-domain>/mcp` |

Then take the **redirect URI** the connector shows you and add it to that client's
`redirectUris` in `OAUTH_CLIENTS`. Complete the **Login** flow in the agent; the agent's tool
calls will reach Sinch through the subproject resolved from the JWT. Start with the `whoami`
tool to confirm the identity chain before exercising `list_active_numbers`.

> Demo-grade identity provider — not for production use.
