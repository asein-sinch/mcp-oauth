import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, type SinchCredentials } from './config.js';
import {
  listActiveNumbers,
  listRcsSenders,
  createRcsSender,
  setRcsSenderCountries,
  addRcsTestNumbers,
  launchRcsSender,
  findRcsAppId,
  sendConversationMessage,
} from './sinch.js';
import { registerAppTool, EXTENSION_ID } from '@modelcontextprotocol/ext-apps/server';
import { buildCreateSenderBody, SUPPORTED_COUNTRIES, RECOMMENDED_COUNTRIES } from './rcsSenderTemplate.js';
import { generateRcsMessage, isRcgConfigured } from './rcg.js';
import { RCS_PREVIEW_URI, registerRcsPreviewResource } from './rcsPreview.js';
import { getEventsByMessageId, getEventsByRange, isEventsConfigured } from './events.js';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const textResult = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

const E164 = /^\+[1-9]\d{6,14}$/;

// Conversation API message body types — used to detect an already-formed `message`.
const CONVERSATION_MESSAGE_KEYS = [
  'text_message', 'card_message', 'carousel_message', 'media_message', 'choice_message',
  'location_message', 'template_message', 'contact_info_message', 'list_message',
];

/**
 * Normalize whatever the agent passes from generate-rcs-message into a Conversation API
 * `message` body. Accepts the body directly (e.g. { card_message: {...} }) or unwraps common
 * shapes: { template: ... }, { canvas: { template: ... } }, or the full structuredContent.
 */
export function toConversationMessage(input: Record<string, unknown>): Record<string, unknown> {
  let m: any = input;
  for (let i = 0; i < 5 && m && typeof m === 'object' && !Array.isArray(m); i++) {
    if (CONVERSATION_MESSAGE_KEYS.some((k) => k in m)) return m;
    if (m.template) { m = m.template; continue; }
    if (m.canvas && m.canvas.template) { m = m.canvas.template; continue; }
    break;
  }
  return m;
}

/**
 * Builds an MCP server whose tools are bound to a single authenticated subproject.
 * One instance is created per request (stateless transport), so `ctx` is the identity
 * extracted from the verified JWT.
 */
export function createMcpServer(ctx: {
  subprojectId: string;
  userEmail?: string;
  creds?: SinchCredentials;
}): McpServer {
  const server = new McpServer({ name: 'sinch-mcp-server', version: '0.1.0' });

  // Run `fn` with the request's resolved Sinch credentials (set by the auth middleware),
  // normalizing errors to a tool result.
  const withSinch = async (fn: (creds: SinchCredentials) => Promise<ToolResult>): Promise<ToolResult> => {
    if (!ctx.creds) {
      return errorResult(`No Sinch credentials available for subproject "${ctx.subprojectId}".`);
    }
    try {
      return await fn(ctx.creds);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  // Proves the auth chain end-to-end without needing live Sinch data — ideal for the demo.
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Returns the Sinch subproject and user identity resolved from the OAuth token. ' +
        'Use this to confirm which Sinch subproject the agent is acting on behalf of.',
    },
    async () =>
      textResult({ subprojectId: ctx.subprojectId, userEmail: ctx.userEmail ?? null }),
  );

  // Example real Sinch call, scoped to the subproject resolved from the JWT.
  server.registerTool(
    'list_active_numbers',
    {
      title: 'List active numbers',
      description:
        'Lists active phone numbers belonging to the Sinch subproject associated with the signed-in user.',
      inputSchema: { pageSize: z.number().int().min(1).max(100).optional() },
    },
    async ({ pageSize }) => withSinch(async (creds) => textResult(await listActiveNumbers(ctx.subprojectId, creds, pageSize ?? 10))),
  );

  server.registerTool(
    'list_rcs_senders',
    {
      title: 'List RCS senders',
      description:
        'Lists the RCS senders for the signed-in subproject. Returns id, state, region, ' +
        'billingCategory, useCase, hostingRegion and brand/countries details for each sender.',
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).optional().describe('Number of senders to return (default 20)'),
        pageToken: z.string().optional().describe('Pagination token from a previous response'),
      },
    },
    async ({ pageSize, pageToken }) =>
      withSinch(async (creds) => {
        const raw = (await listRcsSenders(ctx.subprojectId, creds, pageSize ?? 20, pageToken)) as {
          senders?: Record<string, unknown>[];
          nextPageToken?: string;
          totalSize?: number;
        };
        const senders = (raw.senders ?? []).map((s: any) => ({
          id: s.id,
          state: s.state,
          region: s.region,
          billingCategory: s.billingCategory,
          useCase: s.useCase,
          hostingRegion: s.hostingRegion,
          details: {
            brand: s.details?.brand,
            countries: s.details?.countries,
          },
        }));
        return textResult({ senders, nextPageToken: raw.nextPageToken ?? null, totalSize: raw.totalSize ?? null });
      }),
  );

  // --- RCS sender onboarding flow: create -> add countries -> add test numbers -> launch ---

  server.registerTool(
    'create_rcs_sender',
    {
      title: 'Create RCS sender',
      description:
        'Creates an RCS sender for the signed-in subproject. The brand assets, legal URLs, contact ' +
        'and onboarding questionnaire are pre-filled from company data — you only provide a name and a ' +
        'short description. Returns the new senderId and state, then suggests which countries to add next ' +
        'with `add_rcs_sender_countries`. Full flow: create_rcs_sender -> add_rcs_sender_countries -> ' +
        'add_rcs_test_numbers -> launch_rcs_sender.',
      inputSchema: {
        name: z.string().min(1).max(100).describe('Display/brand name of the RCS sender'),
        description: z.string().min(1).max(2000).describe('Short description of the brand/sender'),
      },
    },
    async ({ name, description }) =>
      withSinch(async (creds) => {
        const sender = (await createRcsSender(ctx.subprojectId, creds, buildCreateSenderBody(name, description))) as {
          id?: string;
          state?: string;
        };
        return textResult({
          message: 'RCS sender created.',
          senderId: sender.id ?? null,
          state: sender.state ?? null,
          nextSteps: [
            'Add target countries with `add_rcs_sender_countries` (pass the senderId above).',
            'Add tester phone numbers with `add_rcs_test_numbers`.',
            'Start the launch with `launch_rcs_sender`.',
          ],
          suggestedCountries: {
            recommended: RECOMMENDED_COUNTRIES,
            note:
              'FR is recommended because the pre-filled questionnaire is for France. Other supported countries ' +
              'may require additional, country-specific questionnaire data (e.g. GB/US) before they can launch.',
            allSupported: SUPPORTED_COUNTRIES,
          },
          sender,
        });
      }),
  );

  server.registerTool(
    'add_rcs_sender_countries',
    {
      title: 'Add countries to RCS sender',
      description:
        'Sets the target countries on a previously created RCS sender (replaces details.countries). ' +
        'Countries are ISO 3166-1 alpha-2 codes. FR is recommended for the pre-filled questionnaire.',
      inputSchema: {
        senderId: z.string().min(1).describe('The senderId returned by create_rcs_sender'),
        countries: z
          .array(z.string().length(2))
          .min(1)
          .describe('ISO 3166-1 alpha-2 country codes, e.g. ["FR"]'),
      },
    },
    async ({ senderId, countries }) => {
      const normalized = countries.map((c) => c.toUpperCase());
      const supported = new Set<string>(SUPPORTED_COUNTRIES);
      const invalid = normalized.filter((c) => !supported.has(c));
      if (invalid.length) {
        return errorResult(
          `Unsupported country code(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_COUNTRIES.join(', ')}.`,
        );
      }
      return withSinch(async (creds) =>
        textResult(await setRcsSenderCountries(ctx.subprojectId, creds, senderId, normalized)),
      );
    },
  );

  server.registerTool(
    'add_rcs_test_numbers',
    {
      title: 'Add test numbers to RCS sender',
      description:
        'Adds tester phone numbers to an RCS sender. Each tester receives an invite to become a tester. ' +
        'Re-adding a verified number resets it to unverified and re-sends the invite.',
      inputSchema: {
        senderId: z.string().min(1).describe('The senderId returned by create_rcs_sender'),
        testNumbers: z
          .array(z.string().regex(E164, 'must be E.164, e.g. +33612345678'))
          .min(1)
          .max(20)
          .describe('Tester phone numbers in E.164 format'),
      },
    },
    async ({ senderId, testNumbers }) =>
      withSinch(async (creds) => textResult(await addRcsTestNumbers(ctx.subprojectId, creds, senderId, testNumbers))),
  );

  server.registerTool(
    'launch_rcs_sender',
    {
      title: 'Launch RCS sender',
      description:
        'Begins the launch process for an RCS sender. Requires the questionnaire completed, at least one ' +
        'country set, a contact email or phone, and brand banner/logo/privacy/terms URLs (all pre-filled). ' +
        'If no questionnaire video was provided the sender enters PENDING_LAUNCH while Sinch adds one.',
      inputSchema: {
        senderId: z.string().min(1).describe('The senderId returned by create_rcs_sender'),
      },
    },
    async ({ senderId }) =>
      withSinch(async (creds) => textResult(await launchRcsSender(ctx.subprojectId, creds, senderId))),
  );

  // Send an RCS message via the Conversation API. Designed to run right after
  // generate-rcs-message: pass that tool's generated body as `message`; this tool only adds the
  // RCS-configured Conversation app (auto-detected) and the recipient.
  server.registerTool(
    'send-rcs-message',
    {
      title: 'Send RCS message',
      description:
        'Sends an RCS message to a recipient via the Sinch Conversation API. Pass the JSON produced ' +
        'by generate-rcs-message as `message` (its `template`, e.g. { "card_message": {...} }); this ' +
        'tool fills in the recipient and the RCS-configured Conversation app (auto-detected from the ' +
        'project if not provided). Typically called right after generate-rcs-message.',
      inputSchema: {
        to: z
          .string()
          .regex(E164, 'must be E.164, e.g. +33612345678')
          .describe('Recipient phone number in E.164 format'),
        message: z
          .record(z.any())
          .describe('Conversation API message body — the generate-rcs-message output (its `template`)'),
        appId: z
          .string()
          .optional()
          .describe('Conversation app id (RCS). Defaults to CONVERSATION_APP_ID or the auto-detected RCS app.'),
        region: z
          .enum(['us', 'eu', 'br'])
          .optional()
          .describe('Conversation API region. Defaults to CONVERSATION_REGION (eu).'),
      },
    },
    async ({ to, message, appId, region }) =>
      withSinch(async (creds) => {
        const usedRegion = region ?? config.conversationRegion;
        let usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          usedAppId = (await findRcsAppId(ctx.subprojectId, creds, usedRegion)) ?? undefined;
        }
        if (!usedAppId) {
          return errorResult(
            'No RCS-configured Conversation app found for this subproject. Provide appId or set CONVERSATION_APP_ID.',
          );
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel: 'RCS', identity: to }] } },
          message: toConversationMessage(message),
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, usedRegion, body));
      }),
  );

  // Plain text message on any Conversation API channel (SMS, WhatsApp, RCS text, …).
  // NOT for rich RCS cards — use generate-rcs-message + send-rcs-message for that.
  server.registerTool(
    'send_text_message',
    {
      title: 'Send text message',
      description:
        'Sends a plain text message to a recipient via the Sinch Conversation API. ' +
        'Use this for simple text on any channel (SMS, WHATSAPP, RCS, …). ' +
        'Do NOT use this for rich RCS cards — for those, call generate-rcs-message first, ' +
        'then send-rcs-message with the generated template.',
      inputSchema: {
        to: z
          .string()
          .regex(E164, 'must be E.164, e.g. +33612345678')
          .describe('Recipient phone number in E.164 format'),
        text: z.string().min(1).describe('Plain text content of the message'),
        channel: z
          .enum(['SMS', 'RCS', 'WHATSAPP', 'MESSENGER', 'VIBER', 'VIBERBM', 'INSTAGRAM', 'TELEGRAM'])
          .default('SMS')
          .describe('Channel to send on (default SMS)'),
        appId: z
          .string()
          .optional()
          .describe('Conversation app id. Defaults to CONVERSATION_APP_ID env var if set.'),
        region: z
          .enum(['us', 'eu', 'br'])
          .optional()
          .describe('Conversation API region. Defaults to CONVERSATION_REGION (eu).'),
      },
    },
    async ({ to, text, channel, appId, region }) =>
      withSinch(async (creds) => {
        const usedRegion = region ?? config.conversationRegion;
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult(
            'No Conversation app id provided. Pass appId or set CONVERSATION_APP_ID.',
          );
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel, identity: to }] } },
          message: { text_message: { text } },
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, usedRegion, body));
      }),
  );

  // --- Generative AI: draft an RCS rich message via the Sinch RCG API ---
  // Uses company-wide Entra credentials (config), not the per-subproject Sinch vault.
  // Registered as an MCP Apps tool so hosts that support it render an interactive preview;
  // others just consume the structured/text result.
  registerAppTool(
    server,
    'generate-rcs-message',
    {
      title: 'Generate RCS message',
      description:
        'Generates an RCS rich message via the Sinch Generative AI Rich Content Generator (RCG). ' +
        'Give a natural-language description (e.g. "Promotional RCS message for a flash sale on sneakers") ' +
        'and it returns the generated RCS canvas template. Pass back the returned conversationId to ' +
        'iteratively refine the same message.',
      inputSchema: {
        description: z
          .string()
          .min(1)
          .describe('Natural-language description of the RCS message to generate'),
        conversationId: z
          .string()
          .optional()
          .describe('Existing RCG conversation ID to continue refining; omit to start a new one'),
        flavorId: z.string().optional().describe('RCG flavor_id (channel/use-case profile). Defaults to "rcs".'),
        baseUrl: z.string().url().optional().describe('Override the RCG base URL'),
      },
      _meta: { ui: { resourceUri: RCS_PREVIEW_URI } },
    },
    async ({ description, conversationId, flavorId, baseUrl }) => {
      if (!isRcgConfigured()) {
        return errorResult(
          'generate-rcs-message is not configured. Set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ' +
            'ENTRA_CLIENT_SECRET and ENTRA_SCOPE (optionally RCG_BASE_URL).',
        );
      }
      try {
        const result = await generateRcsMessage({ description, conversationId, flavorId, baseUrl });
        // Lean text payload for the model; full template+canvas in structuredContent for the preview.
        const lean = {
          success: true as const,
          conversationId: result.conversationId,
          flavorId: result.flavorId,
          template: result.template,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(lean) }],
          structuredContent: { ...lean, canvas: result.canvas, inline_resource_uri: RCS_PREVIEW_URI },
          _meta: { ui: { resourceUri: RCS_PREVIEW_URI }, 'ui/resourceUri': RCS_PREVIEW_URI },
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Events service: delivery tracking and range queries ---

  server.registerTool(
    'get_message_events',
    {
      title: 'Get message events',
      description:
        'Returns the delivery and engagement events for a specific message (delivery status, ' +
        'read receipt, button clicks). Pass the message ID returned by send-rcs-message. ' +
        'Requires the events service (EVENTS_API_URL) to be configured.',
      inputSchema: {
        messageId: z.string().min(1).describe('The message ID returned by send-rcs-message'),
      },
    },
    async ({ messageId }) => {
      if (!isEventsConfigured()) {
        return errorResult('Events service is not configured. Set EVENTS_API_URL (and optionally EVENTS_API_KEY).');
      }
      try {
        return textResult(await getEventsByMessageId(messageId));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_events_by_range',
    {
      title: 'Get events by time range',
      description:
        'Returns all messaging events (delivery, read, opt-in/opt-out, clicks) for a given ' +
        'time period. Use ISO 8601 timestamps. Useful for campaign reporting and analytics.',
      inputSchema: {
        from: z.string().describe('Start of the range, ISO 8601 (e.g. 2026-06-15T00:00:00Z)'),
        to: z.string().describe('End of the range, ISO 8601 (e.g. 2026-06-15T23:59:59Z)'),
      },
    },
    async ({ from, to }) => {
      if (!isEventsConfigured()) {
        return errorResult('Events service is not configured. Set EVENTS_API_URL (and optionally EVENTS_API_KEY).');
      }
      try {
        return textResult(await getEventsByRange(from, to));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // When RCG is configured, expose the preview resource and advertise the MCP Apps extension
  // (must happen before server.connect, which the caller does). Guarded so a non-RCG deployment
  // is unaffected.
  if (isRcgConfigured()) {
    registerRcsPreviewResource(server);
    server.server.registerCapabilities({ extensions: { [EXTENSION_ID]: {} } });
  }

  return server;
}
