import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, type SinchCredentials } from './config.js';
import {
  listActiveNumbers,
  listRcsSenders,
  getRcsSender,
  createRcsSender,
  updateRcsSender,
  launchRcsSender,
  listConversationApps,
  createConversationApp,
  setChannelOnApp,
  listTemplates,
  sendConversationMessage,
  toolContextStore,
} from './sinch.js';
import { generateImagenAsset } from './imagen.js';

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

/**
 * Builds an MCP server whose tools are bound to single-tenant credentials.
 */
export function createMcpServer(ctx: {
  subprojectId: string;
  userEmail?: string;
  creds?: SinchCredentials;
}): McpServer {
  const server = new McpServer({ name: 'sinch-mcp-server', version: '1.0.0' });

  // Run `fn` with the request's resolved Sinch credentials within the async local storage toolContextStore
  const withSinch = async (toolName: string, fn: (creds: SinchCredentials) => Promise<ToolResult>): Promise<ToolResult> => {
    const creds = ctx.creds;
    if (!creds) {
      return errorResult(`No Sinch credentials available.`);
    }
    try {
      return await toolContextStore.run({ toolName }, () => fn(creds));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  // 1. Identity Tool
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Returns the Sinch project and identity details configured in this environment.',
    },
    async () =>
      textResult({
        projectId: ctx.subprojectId,
        userEmail: ctx.userEmail ?? null,
        region: config.conversationRegion,
      }),
  );

  // 2. Active Numbers
  server.registerTool(
    'list_active_numbers',
    {
      title: 'List active numbers',
      description: 'Lists active virtual phone numbers belonging to the Sinch project.',
      inputSchema: { pageSize: z.number().int().min(1).max(100).optional() },
    },
    async ({ pageSize }) =>
      withSinch('list_active_numbers', async (creds) => textResult(await listActiveNumbers(ctx.subprojectId, creds, pageSize ?? 10))),
  );

  // ==========================================
  // OFFICIAL RCS SENDER MANAGEMENT TOOLS
  // ==========================================

  server.registerTool(
    'create-rcs-sender',
    {
      title: 'Create RCS Sender',
      description: 'Creates a new RCS sender for the project. Provide name, short description, usecase, and billing category.',
      inputSchema: {
        name: z.string().min(1).describe('Display name of the RCS sender'),
        description: z.string().min(1).describe('Short brand or use-case description'),
        useCase: z.enum(['PROMOTIONAL', 'TRANSACTIONAL', 'OTP', '2_WAY']).describe('The active use case for this RCS agent/sender'),
        billingCategory: z.enum(['CONVERSATIONAL', 'NON_CONVERSATIONAL', 'BASIC_MESSAGE', 'CONVERSATIONAL_LEGACY', 'SINGLE_MESSAGE']).describe('The billing tier model (e.g. CONVERSATIONAL for rich 2-way engagement, OTP/NON_CONVERSATIONAL for basic text alerts)'),
        countries: z.array(z.string().length(2)).optional().describe('ISO-2 country codes where RCS is active'),
      },
    },
    async ({ name, description, useCase, billingCategory, countries }) =>
      withSinch('create-rcs-sender', async (creds) => {
        const payload = {
          region: 'REGION_EU',
          details: {
            brand: {
              name,
              description,
              logoUrl: 'https://images.sinch.com/logo-placeholder.png', // Fallback placeholder
              bannerUrl: 'https://images.sinch.com/banner-placeholder.png', // Fallback placeholder
            },
            countries: countries ?? [],
          },
          useCase,
          billingCategory,
        };
        return textResult(await createRcsSender(ctx.subprojectId, creds, payload));
      }),
  );

  server.registerTool(
    'get-rcs-sender',
    {
      title: 'Get RCS Sender',
      description: 'Fetches detailed status, country list, verification status, and brand questionnaire details for an RCS sender.',
      inputSchema: {
        senderId: z.string().min(1).describe('The unique senderId of the RCS agent'),
      },
    },
    async ({ senderId }) =>
      withSinch('get-rcs-sender', async (creds) => textResult(await getRcsSender(ctx.subprojectId, creds, senderId))),
  );

  server.registerTool(
    'list-rcs-senders',
    {
      title: 'List RCS Senders',
      description: 'Lists all RCS senders and their operational states in the project.',
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).optional().describe('Count of senders to return (default 100)'),
        pageToken: z.string().optional().describe('Token for next page results'),
      },
    },
    async ({ pageSize, pageToken }) =>
      withSinch('list-rcs-senders', async (creds) => textResult(await listRcsSenders(ctx.subprojectId, creds, pageSize ?? 100, pageToken))),
  );

  server.registerTool(
    'update-rcs-sender',
    {
      title: 'Update RCS Sender',
      description: 'Updates (PATCH) specific details on an RCS sender, such as adding country details, test phone numbers, or answering onboarding questionnaires.',
      inputSchema: {
        senderId: z.string().min(1).describe('The unique senderId of the RCS agent'),
        body: z.record(z.any()).describe('The patched properties to merge on the RCS sender, following the Sinch Provisioning API schema'),
      },
    },
    async ({ senderId, body }) =>
      withSinch('update-rcs-sender', async (creds) => textResult(await updateRcsSender(ctx.subprojectId, creds, senderId, body))),
  );

  server.registerTool(
    'launch-rcs-sender',
    {
      title: 'Launch RCS Sender',
      description: 'Launches and requests final operator activation for the RCS sender. The sender must have completed questionnaires, test numbers, and valid details.',
      inputSchema: {
        senderId: z.string().min(1).describe('The unique senderId of the RCS agent'),
      },
    },
    async ({ senderId }) =>
      withSinch('launch-rcs-sender', async (creds) => textResult(await launchRcsSender(ctx.subprojectId, creds, senderId))),
  );

  // ==========================================
  // OFFICIAL CONVERSATION MESSAGING & ADMIN TOOLS
  // ==========================================

  server.registerTool(
    'list-conversation-apps',
    {
      title: 'List Conversation Apps',
      description: 'Lists all Conversation API apps configured in the project. Calls are scoped strictly to the server region.',
      inputSchema: {},
    },
    async () =>
      withSinch('list-conversation-apps', async (creds) => textResult(await listConversationApps(ctx.subprojectId, creds, config.conversationRegion))),
  );

  server.registerTool(
    'create-conversation-app',
    {
      title: 'Create Conversation App',
      description: 'Creates a new empty Conversation API app. Scoped to the server regional environment.',
      inputSchema: {
        displayName: z.string().min(1).describe('Human-readable display name of the Conversation App'),
      },
    },
    async ({ displayName }) =>
      withSinch('create-conversation-app', async (creds) => textResult(await createConversationApp(ctx.subprojectId, creds, config.conversationRegion, displayName))),
  );

  server.registerTool(
    'set-rcs-channel-on-app',
    {
      title: 'Configure RCS on App',
      description: 'Adds or replaces the RCS channel configuration on a specific Conversation App. Only one RCS channel is permitted per app.',
      inputSchema: {
        appId: z.string().min(1).describe('The unique Conversation App ID'),
        senderId: z.string().min(1).describe('The launched/verified RCS sender ID'),
        bearerToken: z.string().min(1).describe('The bearer token used for the RCS channel'),
      },
    },
    async ({ appId, senderId, bearerToken }) =>
      withSinch('set-rcs-channel-on-app', async (creds) => {
        const channelData = {
          channel: 'RCS',
          rcs_credentials: {
            sender_id: senderId,
            bearer_token: bearerToken,
          },
        };
        return textResult(await setChannelOnApp(ctx.subprojectId, creds, config.conversationRegion, appId, channelData));
      }),
  );

  server.registerTool(
    'set-sms-channel-on-app',
    {
      title: 'Configure SMS on App',
      description: 'Adds or replaces the SMS channel configuration on a specific Conversation App. Only one SMS channel is permitted per app.',
      inputSchema: {
        appId: z.string().min(1).describe('The unique Conversation App ID'),
        servicePlanId: z.string().min(1).describe('The Sinch SMS Service Plan ID'),
        apiToken: z.string().min(1).describe('The API Token for the SMS service plan'),
      },
    },
    async ({ appId, servicePlanId, apiToken }) =>
      withSinch('set-sms-channel-on-app', async (creds) => {
        const channelData = {
          channel: 'SMS',
          sms_credentials: {
            service_plan_id: servicePlanId,
            api_token: apiToken,
          },
        };
        return textResult(await setChannelOnApp(ctx.subprojectId, creds, config.conversationRegion, appId, channelData));
      }),
  );

  server.registerTool(
    'set-whatsapp-channel-on-app',
    {
      title: 'Configure WhatsApp on App',
      description: 'Adds or replaces the WhatsApp channel configuration on a specific Conversation App. Only one WhatsApp channel is permitted per app.',
      inputSchema: {
        appId: z.string().min(1).describe('The unique Conversation App ID'),
        whatsappBusinessAccountId: z.string().min(1).describe('The WhatsApp Business Account ID'),
      },
    },
    async ({ appId, whatsappBusinessAccountId }) =>
      withSinch('set-whatsapp-channel-on-app', async (creds) => {
        const channelData = {
          channel: 'WHATSAPP',
          whatsapp_credentials: {
            whatsapp_business_account_id: whatsappBusinessAccountId,
          },
        };
        return textResult(await setChannelOnApp(ctx.subprojectId, creds, config.conversationRegion, appId, channelData));
      }),
  );

  server.registerTool(
    'list-templates',
    {
      title: 'List Conversation Templates',
      description: 'Lists configured omni-channel messaging templates in the project for the server region.',
      inputSchema: {},
    },
    async () =>
      withSinch('list-templates', async (creds) => textResult(await listTemplates(ctx.subprojectId, creds, config.conversationRegion))),
  );

  server.registerTool(
    'send-text-message',
    {
      title: 'Send Text Message',
      description: 'Sends a plain text message to a recipient via the Sinch Conversation API.',
      inputSchema: {
        to: z.string().regex(E164, 'must be E.164 format, e.g. +33612345678').describe('Recipient phone number in E.164 format'),
        text: z.string().min(1).describe('Plain text content of the message'),
        channel: z.enum(['SMS', 'RCS', 'WHATSAPP']).default('SMS').describe('Channel to route the message through (SMS, RCS, WHATSAPP)'),
        appId: z.string().optional().describe('Conversation app ID. Defaults to CONVERSATION_APP_ID if unset.'),
      },
    },
    async ({ to, text, channel, appId }) =>
      withSinch('send-text-message', async (creds) => {
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult('No Conversation app id provided. Provide appId or set CONVERSATION_APP_ID.');
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel, identity: to }] } },
          message: { text_message: { text } },
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, config.conversationRegion, body));
      }),
  );

  server.registerTool(
    'send-media-message',
    {
      title: 'Send Media Message',
      description: 'Sends a media message (image, video, document) to a recipient via the Sinch Conversation API.',
      inputSchema: {
        to: z.string().regex(E164, 'must be E.164 format, e.g. +33612345678').describe('Recipient phone number in E.164 format'),
        url: z.string().url().describe('The public URL of the media file to send'),
        channel: z.enum(['RCS', 'WHATSAPP']).default('RCS').describe('Channel to route the message through (RCS, WHATSAPP)'),
        appId: z.string().optional().describe('Conversation app ID. Defaults to CONVERSATION_APP_ID if unset.'),
      },
    },
    async ({ to, url, channel, appId }) =>
      withSinch('send-media-message', async (creds) => {
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult('No Conversation app id provided. Provide appId or set CONVERSATION_APP_ID.');
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel, identity: to }] } },
          message: { media_message: { url } },
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, config.conversationRegion, body));
      }),
  );

  server.registerTool(
    'send-template-message',
    {
      title: 'Send Omni Template Message',
      description: 'Sends a pre-configured omnichannel template message ("omni-template") with custom parameters to a recipient.',
      inputSchema: {
        to: z.string().regex(E164, 'must be E.164 format, e.g. +33612345678').describe('Recipient phone number in E.164 format'),
        templateId: z.string().min(1).describe('The ID of the omni template'),
        languageCode: z.string().default('en').describe('Language code of the template'),
        parameters: z.record(z.string()).optional().describe('Template key-value parameters to interpolate'),
        channel: z.enum(['SMS', 'RCS', 'WHATSAPP']).default('SMS').describe('Channel to route the message through'),
        appId: z.string().optional().describe('Conversation app ID.'),
      },
    },
    async ({ to, templateId, languageCode, parameters, channel, appId }) =>
      withSinch('send-template-message', async (creds) => {
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult('No Conversation app id provided. Provide appId or set CONVERSATION_APP_ID.');
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel, identity: to }] } },
          message: {
            template_message: {
              omni_template: {
                template_id: templateId,
                language_code: languageCode,
                parameters: parameters ?? {},
              },
            },
          },
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, config.conversationRegion, body));
      }),
  );

  server.registerTool(
    'send-whatsapp-template-message',
    {
      title: 'Send WhatsApp Template Message',
      description: 'Sends a WhatsApp-specific template message to a recipient.',
      inputSchema: {
        to: z.string().regex(E164, 'must be E.164 format, e.g. +33612345678').describe('Recipient phone number in E.164 format'),
        templateName: z.string().min(1).describe('The WhatsApp template name'),
        languageCode: z.string().default('en').describe('Language code of the template'),
        parameters: z.array(z.any()).optional().describe('Template components and parameter values'),
        appId: z.string().optional().describe('Conversation app ID.'),
      },
    },
    async ({ to, templateName, languageCode, parameters, appId }) =>
      withSinch('send-whatsapp-template-message', async (creds) => {
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult('No Conversation app id provided. Provide appId or set CONVERSATION_APP_ID.');
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel: 'WHATSAPP', identity: to }] } },
          message: {
            template_message: {
              whatsapp_template: {
                template_name: templateName,
                language_code: languageCode,
                components: parameters ?? [],
              },
            },
          },
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, config.conversationRegion, body));
      }),
  );

  server.registerTool(
    'send-choice-message',
    {
      title: 'Send Choice Message',
      description: 'Sends an interactive choice message (with buttons or quick-replies) to a recipient.',
      inputSchema: {
        to: z.string().regex(E164, 'must be E.164 format, e.g. +33612345678').describe('Recipient phone number in E.164 format'),
        text: z.string().min(1).describe('The text prompt content accompanying the choices'),
        choices: z.array(z.any()).describe('The choices list (e.g. [{ text: "Yes", postback_data: "yes_clicked" }])'),
        channel: z.enum(['RCS', 'WHATSAPP']).default('RCS').describe('Channel to route the message through'),
        appId: z.string().optional().describe('Conversation app ID.'),
      },
    },
    async ({ to, text, choices, channel, appId }) =>
      withSinch('send-choice-message', async (creds) => {
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult('No Conversation app id provided. Provide appId or set CONVERSATION_APP_ID.');
        }
        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel, identity: to }] } },
          message: {
            choice_message: {
              text_message: { text },
              choices: choices,
            },
          },
        };
        return textResult(await sendConversationMessage(ctx.subprojectId, creds, config.conversationRegion, body));
      }),
  );

  server.registerTool(
    'send-card-or-choice-message',
    {
      title: 'Send Card or Choice Message',
      description: 'Sends a card message (if mediaUrl is provided) or a choice message (if no mediaUrl is provided) via the Sinch Conversation API.',
      inputSchema: {
        to: z.string().regex(E164, 'must be E.164 format, e.g. +33612345678').describe('Recipient phone number in E.164 format'),
        title: z.string().optional().describe('Title of the card (only used if mediaUrl is provided)'),
        description: z.string().min(1).describe('Description of the card or the main text content of the choice message'),
        mediaUrl: z.string().url().optional().describe('Optional public URL of the media file (image) to include in the card'),
        choices: z.array(z.any()).describe('The choices/buttons list. Each item can be { text: "Label", postback_data: "data" } or Sinch-formatted.'),
        channel: z.enum(['RCS', 'WHATSAPP']).default('RCS').describe('Channel to route the message through'),
        appId: z.string().optional().describe('Conversation app ID.'),
      },
    },
    async ({ to, title, description, mediaUrl, choices, channel, appId }) =>
      withSinch('send-card-or-choice-message', async (creds) => {
        const usedAppId = appId ?? config.conversationAppId;
        if (!usedAppId) {
          return errorResult('No Conversation app id provided. Provide appId or set CONVERSATION_APP_ID.');
        }

        // Format choices to Sinch standard if they are simplified
        const formattedChoices = choices.map((c: any) => {
          if (c && typeof c === 'object') {
            if ('text' in c && 'postback_data' in c && !('text_message' in c)) {
              return {
                text_message: { text: c.text },
                postback_data: c.postback_data,
              };
            }
          }
          return c;
        });

        let messageBody: any;

        if (mediaUrl) {
          // If media is present, construct a card message
          messageBody = {
            card_message: {
              title: title || 'Campaign Card',
              description: description,
              media_message: {
                url: mediaUrl,
              },
              choices: formattedChoices,
            },
          };
        } else {
          // Fallback to choice message
          messageBody = {
            choice_message: {
              text_message: { text: description },
              choices: formattedChoices,
            },
          };
        }

        const body = {
          app_id: usedAppId,
          recipient: { identified_by: { channel_identities: [{ channel, identity: to }] } },
          message: messageBody,
        };

        return textResult(await sendConversationMessage(ctx.subprojectId, creds, config.conversationRegion, body));
      }),
  );

  server.registerTool(
    'generate-campaign-image',
    {
      title: 'Generate Campaign Image',
      description: 'Generates a marketing campaign image based on a descriptive text prompt. Returns the image URL.',
      inputSchema: {
        prompt: z.string().min(1).describe('The descriptive visual prompt of the marketing asset to generate (e.g. "A luxurious basket of tricolour French cookies, 8k, studio lighting").'),
        aspectRatio: z.enum(['1:1', '16:9', '4:3', '9:16', '3:4']).default('16:9').describe('The aspect ratio of the generated campaign image. Default is "16:9" which is the optimal ratio for mobile banners and rich card previews without truncation.'),
      },
    },
    async ({ prompt, aspectRatio }) => {
      try {
        const imageUrl = await generateImagenAsset(prompt, aspectRatio, '0.5K');
        return textResult({ imageUrl });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
export default createMcpServer;
