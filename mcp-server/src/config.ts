import { z } from 'zod';

/** Configuration for the single-tenant MCP server, validated at startup. */

const envSchema = z.object({
  PORT: z.coerce.number().default(8090),

  // Single-tenant project ID:
  SINCH_PROJECT_ID: z.string().optional(),
  PROJECT_ID: z.string().optional(),

  // Base64 encoded "accessKey:accessSecret"
  SINCH_CREDENTIALS: z.string().optional(),

  // Fallback explicit credentials (can be raw)
  SINCH_ACCESS_KEY: z.string().optional(),
  SINCH_ACCESS_SECRET: z.string().optional(),

  // Sinch endpoints (sensible production defaults)
  SINCH_AUTH_URL: z.string().url().default('https://auth.sinch.com/oauth2/token'),
  SINCH_NUMBERS_BASE: z.string().url().default('https://numbers.api.sinch.com'),
  SINCH_PROVISIONING_BASE: z.string().url().default('https://provisioning.api.sinch.com'),

  // Conversation API regional settings
  CONVERSATION_APP_ID: z.string().optional(),
  CONVERSATION_REGION: z.enum(['us', 'eu', 'br']).default('eu'),
});

const raw = envSchema.parse(process.env);

// 1. Resolve Project ID
const projectId = raw.SINCH_PROJECT_ID || raw.PROJECT_ID;
if (!projectId) {
  throw new Error('❌ SINCH_PROJECT_ID or PROJECT_ID must be set in the environment variables!');
}

// 2. Decode credentials
let accessKey = raw.SINCH_ACCESS_KEY;
let accessSecret = raw.SINCH_ACCESS_SECRET;

if (raw.SINCH_CREDENTIALS) {
  try {
    const trimmed = raw.SINCH_CREDENTIALS.trim();
    // Decode base64 "accessKey:accessSecret"
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx > 0) {
      accessKey = decoded.slice(0, colonIdx);
      accessSecret = decoded.slice(colonIdx + 1);
      console.log('🔑 Successfully decoded SINCH_CREDENTIALS from base64.');
    } else {
      console.warn('⚠️ SINCH_CREDENTIALS does not contain expected colon separator ":".');
    }
  } catch (err) {
    console.error('⚠️ Failed to decode SINCH_CREDENTIALS as base64:', err);
  }
}

if (!accessKey || !accessSecret) {
  throw new Error(
    '❌ Sinch credentials must be provided! Set either SINCH_CREDENTIALS (base64 encoded "accessKey:accessSecret") ' +
      'or both SINCH_ACCESS_KEY and SINCH_ACCESS_SECRET env variables!'
  );
}

export interface SinchCredentials {
  accessKey: string;
  accessSecret: string;
}

export const config = {
  port: raw.PORT,
  projectId,
  accessKey,
  accessSecret,
  sinchAuthUrl: raw.SINCH_AUTH_URL,
  sinchNumbersBase: raw.SINCH_NUMBERS_BASE,
  sinchProvisioningBase: raw.SINCH_PROVISIONING_BASE,
  conversationAppId: raw.CONVERSATION_APP_ID,
  conversationRegion: raw.CONVERSATION_REGION,
};
