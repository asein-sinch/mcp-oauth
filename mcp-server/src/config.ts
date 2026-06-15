import { z } from 'zod';

/** Configuration for the MCP server, validated at startup. */

const credSchema = z.object({
  accessKey: z.string().min(1),
  accessSecret: z.string().min(1),
});

const envSchema = z
  .object({
    PORT: z.coerce.number().default(8090),

    // How incoming requests are authenticated and how Sinch credentials are resolved:
    //  - jwt          : verify a JWT against the auth server's JWKS; subproject_id -> vault.
    //  - static-token : Bearer base64("projectId:accessKey:accessSecret"); creds come from the token.
    //  - none         : no client auth; a single hardcoded credential set is used for every request.
    AUTH_MODE: z.enum(['jwt', 'static-token', 'none']).default('jwt'),

    // --- jwt mode ---
    JWKS_URL: z.string().url().optional(),
    EXPECTED_ISSUER: z.string().url().optional(),
    EXPECTED_AUDIENCE: z.string().url().optional(),
    // The "vault": subproject_id -> Sinch access key/secret.
    // JSON: { "<subproject_id>": { "accessKey": "...", "accessSecret": "..." } }
    SINCH_CREDENTIALS: z.string().optional(),

    // --- none mode (single hardcoded credential set) ---
    SINCH_PROJECT_ID: z.string().optional(),
    SINCH_ACCESS_KEY: z.string().optional(),
    SINCH_ACCESS_SECRET: z.string().optional(),

    // Sinch endpoints (overridable; sensible defaults below).
    SINCH_AUTH_URL: z.string().url().default('https://auth.sinch.com/oauth2/token'),
    SINCH_NUMBERS_BASE: z.string().url().default('https://numbers.api.sinch.com'),
    SINCH_PROVISIONING_BASE: z.string().url().default('https://provisioning.api.sinch.com'),

    // Sinch Generative AI Rich Content Generator (RCG) — powers `generate-rcs-message`.
    // Authenticated via Microsoft Entra client-credentials (company-wide, not per-subproject).
    // All optional: the tool returns a clear error if they are absent.
    ENTRA_TENANT_ID: z.string().optional(),
    ENTRA_CLIENT_ID: z.string().optional(),
    ENTRA_CLIENT_SECRET: z.string().optional(),
    ENTRA_SCOPE: z.string().optional(),
    RCG_BASE_URL: z.string().url().default('https://genai.eu.saas.sinch.com'),

    // Conversation API (for send-rcs-message). The app id is auto-detected from the project's
    // RCS-enabled app when not set here / passed in.
    CONVERSATION_APP_ID: z.string().optional(),
    CONVERSATION_REGION: z.enum(['us', 'eu', 'br']).default('eu'),

    // Events service (sinch-events-server) — powers get_message_events and get_events_by_range.
    // All optional: tools return a clear error if absent.
    EVENTS_API_URL: z.string().url().optional(),
    EVENTS_API_KEY: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const require = (key: keyof typeof v, present: unknown) => {
      if (!present) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is required when AUTH_MODE=${v.AUTH_MODE}`,
          path: [key],
        });
      }
    };
    if (v.AUTH_MODE === 'jwt') {
      require('JWKS_URL', v.JWKS_URL);
      require('EXPECTED_ISSUER', v.EXPECTED_ISSUER);
      require('EXPECTED_AUDIENCE', v.EXPECTED_AUDIENCE);
      require('SINCH_CREDENTIALS', v.SINCH_CREDENTIALS);
    } else if (v.AUTH_MODE === 'none') {
      require('SINCH_PROJECT_ID', v.SINCH_PROJECT_ID);
      require('SINCH_ACCESS_KEY', v.SINCH_ACCESS_KEY);
      require('SINCH_ACCESS_SECRET', v.SINCH_ACCESS_SECRET);
    }
    // static-token mode needs no extra config (creds travel in the token).
  });

const raw = envSchema.parse(process.env);

// Parse the vault map only in jwt mode (the only mode that uses it).
let credentials: Record<string, z.infer<typeof credSchema>> = {};
if (raw.SINCH_CREDENTIALS) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.SINCH_CREDENTIALS);
  } catch {
    throw new Error('SINCH_CREDENTIALS is not valid JSON');
  }
  credentials = z.record(credSchema).parse(parsed);
}

export const config = {
  port: raw.PORT,
  authMode: raw.AUTH_MODE,
  jwksUrl: raw.JWKS_URL,
  expectedIssuer: raw.EXPECTED_ISSUER,
  expectedAudience: raw.EXPECTED_AUDIENCE,
  credentials,
  // none-mode hardcoded credential set
  staticProjectId: raw.SINCH_PROJECT_ID,
  staticAccessKey: raw.SINCH_ACCESS_KEY,
  staticAccessSecret: raw.SINCH_ACCESS_SECRET,
  sinchAuthUrl: raw.SINCH_AUTH_URL,
  sinchNumbersBase: raw.SINCH_NUMBERS_BASE,
  sinchProvisioningBase: raw.SINCH_PROVISIONING_BASE,
  entra: {
    tenantId: raw.ENTRA_TENANT_ID,
    clientId: raw.ENTRA_CLIENT_ID,
    clientSecret: raw.ENTRA_CLIENT_SECRET,
    scope: raw.ENTRA_SCOPE,
  },
  rcgBaseUrl: raw.RCG_BASE_URL,
  conversationAppId: raw.CONVERSATION_APP_ID,
  conversationRegion: raw.CONVERSATION_REGION,
  eventsApiUrl: raw.EVENTS_API_URL,
  eventsApiKey: raw.EVENTS_API_KEY,
};

export type SinchCredentials = z.infer<typeof credSchema>;
