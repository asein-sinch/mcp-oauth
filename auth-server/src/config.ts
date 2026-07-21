import { z } from 'zod';

/**
 * Loads and validates all configuration from environment variables.
 * Throws at startup (fail fast) if anything required is missing or malformed.
 */

const clientSchema = z.object({
  clientSecret: z.string().min(1),
  redirectUris: z.array(z.string().url()).min(0), // empty array = device-flow-only client
});

const userSchema = z.object({
  // the Sinch Build subproject this user is mapped to -> becomes the JWT claim
  subprojectId: z.string().min(1),
});

const envSchema = z
  .object({
    PORT: z.coerce.number().default(8080),
    // Public HTTPS URL of THIS auth server. Used as the JWT `iss`.
    ISSUER_URL: z.string().url(),
    // The MCP server URL. Used as the JWT `aud` so the MCP server can verify it is the audience.
    AUDIENCE: z.string().url(),
    ACCESS_TOKEN_TTL: z.coerce.number().default(3600),
    // RSA private key (PKCS8 PEM). Newlines may be escaped as \n in the env var.
    PRIVATE_KEY_PEM: z.string().min(1),
    // Stable key id published in the JWKS and stamped into each JWT header.
    KEY_ID: z.string().default('demo-key-1'),
    SESSION_SECRET: z.string().min(8),
    // JSON: { "<client_id>": { "clientSecret": "...", "redirectUris": ["https://..."] } }
    OAUTH_CLIENTS: z.string().transform((s, ctx) => parseJson(s, ctx, 'OAUTH_CLIENTS')),
    // JSON: { "<email>": { "passwordHash": "...", "subprojectId": "..." } }
    // Only used by LOGIN_MODE=local. Defaults to empty so dashboard-only deploys need not set it.
    USERS: z
      .string()
      .default('{}')
      .transform((s, ctx) => parseJson(s, ctx, 'USERS')),

    // --- Login mode -----------------------------------------------------------
    //  - local     : authenticate against the bcrypt USERS map; user -> fixed subproject_id.
    //  - dashboard : the user pastes their Sinch dashboard (CCP) bearer token; we then list their
    //                accounts + projects via GraphQL and mint M2M creds on demand (token exchange).
    //  - scripted  : the user types their real Sinch ID email/password (+SMS OTP); we drive the
    //                Auth0 login chain ourselves to obtain the session cookie, then mint a static
    //                access-key token immediately (no back-channel exchange).
    LOGIN_MODE: z.enum(['local', 'dashboard', 'scripted']).default('local'),
    // When set ("1"/"true"), dashboard.ts returns fixtures instead of calling the real GraphQL API.
    DASHBOARD_MOCK: z.string().optional(),
    // Testing only: forces getAccessKeyUsage() to report every project as at the 10-key cap.
    DASHBOARD_MOCK_AT_CAP: z.string().optional(),

    // Sinch Customer Dashboard GraphQL API (accounts, projects, access keys), authorized by the
    // pasted CCP bearer token (iss: "CCP").
    DASHBOARD_GRAPHQL_URL: z.string().url().default('https://dashboard.api.sinch.com/graphql'),
    // client_credentials endpoint to turn a minted access key into a Sinch M2M token.
    SINCH_AUTH_URL: z.string().url().default('https://auth.sinch.com/oauth2/token'),
    // Display name for the throwaway access key we create per project (reuse-or-recreate).
    ACCESS_KEY_DISPLAY_NAME: z.string().default('gemini-mcp-demo'),
  });

function parseJson(s: string, ctx: z.RefinementCtx, name: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} is not valid JSON` });
    return z.NEVER;
  }
}

const raw = envSchema.parse(process.env);

const clients = z.record(clientSchema).parse(raw.OAUTH_CLIENTS);
const users = z.record(userSchema).parse(raw.USERS);

export const config = {
  port: raw.PORT,
  issuerUrl: raw.ISSUER_URL.replace(/\/$/, ''),
  audience: raw.AUDIENCE,
  accessTokenTtl: raw.ACCESS_TOKEN_TTL,
  privateKeyPem: raw.PRIVATE_KEY_PEM.replace(/\\n/g, '\n'),
  keyId: raw.KEY_ID,
  sessionSecret: raw.SESSION_SECRET,
  clients,
  users,
  loginMode: raw.LOGIN_MODE,
  dashboardMock: raw.DASHBOARD_MOCK === '1' || raw.DASHBOARD_MOCK === 'true',
  dashboardMockAtCap: raw.DASHBOARD_MOCK_AT_CAP === '1' || raw.DASHBOARD_MOCK_AT_CAP === 'true',
  dashboardGraphqlUrl: raw.DASHBOARD_GRAPHQL_URL,
  sinchAuthUrl: raw.SINCH_AUTH_URL,
  accessKeyDisplayName: raw.ACCESS_KEY_DISPLAY_NAME,
};

export type OAuthClient = z.infer<typeof clientSchema>;
export type DemoUser = z.infer<typeof userSchema>;
