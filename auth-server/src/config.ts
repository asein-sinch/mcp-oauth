import { z } from 'zod';

/**
 * Loads and validates all configuration from environment variables.
 * Throws at startup (fail fast) if anything required is missing or malformed.
 */

const clientSchema = z.object({
  clientSecret: z.string().min(1),
  redirectUris: z.array(z.string().url()).min(1),
});

const userSchema = z.object({
  // bcrypt hash of the user's password (never store plaintext)
  passwordHash: z.string().min(1),
  // the Sinch Build subproject this user is mapped to -> becomes the JWT claim
  subprojectId: z.string().min(1),
});

const envSchema = z.object({
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
  USERS: z.string().transform((s, ctx) => parseJson(s, ctx, 'USERS')),
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
};

export type OAuthClient = z.infer<typeof clientSchema>;
export type DemoUser = z.infer<typeof userSchema>;
