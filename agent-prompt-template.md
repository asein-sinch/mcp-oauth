# Sinch RCS Messaging Agent

## Goal

The goal is to enable enterprise teams to autonomously manage RCS communication channels and
execute AI-powered messaging campaigns directly within Gemini Enterprise — without leaving Google
Workspace.

Businesses that already hold a Sinch account install the Sinch connector once in their Gemini
Enterprise environment. From that point on, their employees sign in through the Sinch OAuth server
and interact with the Sinch platform using natural language, with each action automatically scoped
to their authorized Sinch subproject. Three roles govern what each user can do:

- **Channel Administrators** onboard and manage RCS senders for their brand.
- **Campaign Managers** generate AI-crafted rich messages and send them to customers over RCS.
- **Insights Managers** query messaging events and campaign performance across any time period.

---

## Agentic functions and reasoning

### Channel Administrator

**Sender creation and brand configuration**
The agent walks the administrator through the full RCS sender onboarding flow interactively. It
asks for each required piece of information in sequence — sender name, brand description, logo
and banner URLs, privacy policy and terms of service links, contact details, and the
country-specific regulatory questionnaire — one step at a time, explaining why each field is
needed and what format is expected. The agent validates inputs as it goes, catching issues (e.g.
a non-HTTPS URL, a missing mandatory questionnaire answer) before they reach the API. Once all
information is collected, it creates the sender in a single call. It then reasons about which
target countries are immediately supported by the completed questionnaire and proactively
recommends starting with those, flagging any additional markets that would require supplementary
regulatory information.

**Country and tester management**
The agent adds or updates the list of target countries on an existing sender, validates each
country code, and explains which ones are supported. It also manages tester phone numbers —
adding testers and explaining that each one will receive a verification invite — before the sender
goes live.

**Launch orchestration**
Once the sender is fully configured (countries set, testers added, questionnaire complete), the
agent triggers the launch request. It explains what happens next (Sinch review, expected
timelines) and what state transitions to expect, guiding the administrator through to a live
sender without requiring any API knowledge.

---

### Campaign Manager

**AI-powered rich message generation**
Given a natural-language description of the campaign objective (e.g. "Promotional flash sale for
running shoes, French audience"), the agent calls the Sinch Generative AI Rich Content Generator
to produce a fully structured RCS rich message — card layout, suggested action buttons, imagery
guidance. It surfaces an interactive preview of the result directly in the Gemini chat interface.

**Iterative refinement**
The agent supports multi-turn refinement: the manager can ask to adjust the tone, swap the call
to action, or try a carousel layout, and the agent resubmits to the generator reusing the same
conversation context. Each revision is previewed before the manager commits.

**Message delivery**
When the manager approves the content, the agent identifies the correct RCS-enabled Conversation
app associated with the user's Sinch subproject (auto-detected, no manual configuration
required), and sends the message to the specified recipient phone number. The Sinch Conversation
API confirms the message was accepted and returns a message ID — this only means the request was
syntactically valid and queued, not that it was delivered.

**Delivery tracking**
Actual delivery status is asynchronous: the agent can query the events associated with a message
ID to surface what happened after submission — whether the message was delivered to the device,
read by the recipient, or whether a button in the RCS card was tapped. This closes the loop for
the Campaign Manager without requiring them to leave the Gemini interface or inspect webhook
logs manually.

---

### Insights Manager

**Event retrieval and filtering**
The agent retrieves messaging events from the Sinch platform for a user-specified time window.
It reasons about the query scope — whether the user wants a broad period overview or a narrower
slice (e.g. "last campaign", "this week", "past 30 days") — and translates that into the
appropriate API call without requiring the user to know timestamps or pagination.

**Delivery and engagement analysis**
The agent surfaces delivery events (sent, delivered, failed) alongside engagement signals (read
receipts, suggested action button clicks), giving the Insights Manager a complete picture of how
a campaign performed. It can break results down by sender, country, or date range on request.

**Consent tracking**
The agent reports opt-in and opt-out events, allowing the Insights Manager to monitor the
evolution of the reachable audience over time and flag any significant opt-out spikes for
follow-up.

**Aggregated campaign stats**
Beyond raw events, the agent computes summary metrics — delivery rate, read rate, click-through
rate — for a given campaign or sender, presenting them in a clear, conversational format ready
for reporting or further discussion.

---

## Required system integrations

### Internal (Sinch platform)

**Sinch Provisioning API**
Used by Channel Administrators for the full RCS sender lifecycle: creation, country targeting,
tester management, and launch. All calls are scoped to the user's authorized Sinch subproject,
derived from their OAuth token.

**Sinch Generative AI — Rich Content Generator (RCG)**
Used by Campaign Managers to generate structured RCS rich message templates from a
natural-language description. Supports multi-turn conversation for iterative refinement of the
same message.

**Sinch Conversation API**
Used by Campaign Managers to deliver the approved RCS message to the recipient. The agent
automatically selects the RCS-enabled Conversation app for the user's subproject, requiring no
manual app ID lookup. Also used by Insights Managers to retrieve message events, delivery
receipts, engagement signals, and opt-in/opt-out records for any requested time period.

**Sinch OAuth 2.0 Authorization Server**
The Sinch connector in Gemini Enterprise is configured with a custom OAuth provider hosted by
Sinch. When a user initiates a session, they are redirected to the Sinch login page, authenticate
with their company credentials, and receive a signed JWT. The JWT carries their identity and
their authorized Sinch subproject, so every action taken through the agent is automatically
scoped to the correct account — no shared credentials, no manual project selection.

### Third-party / external

None — all integrations are provided directly by the Sinch platform.
