# Gemini extras dump — findings for DEVEXP-1544 / DEVEXP-1545

## Where to chat

New Gemini Enterprise app in `vusa-sinchagentaxdx-dev` (do **not** use antoine for this dump):

- Engine / APP_ID: `gemini-auth-v2-dump`
- Display name: Gemini Auth V2 Dump
- Agent: `sinch_messaging_agent` (`sharingConfig.scope=ALL_USERS`)
- Console: [Gemini Auth V2 Dump](https://console.cloud.google.com/gen-app-builder/locations/global/engines/gemini-auth-v2-dump/preview?project=vusa-sinchagentaxdx-dev)

The previous app `gemini-enterprise-test1-antoine` was left registered as-is.

## Dump deployment

- Service: `sinch-messaging-agent`
- URL (registered in the agent card): https://sinch-messaging-agent-227017598651.us-central1.run.app
- Legacy alias, also valid: https://sinch-messaging-agent-csae6ufzhq-uc.a.run.app
- Deployment script: `./cloud_run.sh` (or `./deploy_cloud_run.sh`) in `agent-py/`
- Flag: `DUMP_AGENT_CONTEXT=true` (enabled in Cloud Run environment)
- Invokers: Discovery Engine SA `service-227017598651@gcp-sa-discoveryengine.iam.gserviceaccount.com`, plus `jesake@on.sinch.com`.
- There is **no Agent Engine** in this project, so `dump_proxy_context` is unused.

```bash
gcloud logging read 'textPayload:"[CONTEXT DUMP]"' \
  --project=vusa-sinchagentaxdx-dev \
  --freshness=1d \
  --limit=20
```

Dump kinds:

- `http` — FastAPI request on Cloud Run (Gemini → this URL)
- `executor` — A2A `RequestContext` + ADK `session` after session get/create

## Known issue: Gemini 404 on `/v1/message:send`

First Gemini chat returned `404 Not Found for url .../v1/message:send` on the legacy
`sinch-messaging-agent-csae6ufzhq-uc.a.run.app` host, and **no matching request appeared in the
Cloud Run request logs** — the call never reached the service. Two things were corrected:

1. The registered `jsonAgentCard.url` now uses the canonical
   `https://sinch-messaging-agent-227017598651.us-central1.run.app` host.
2. The live `/.well-known/agent-card.json` used to advertise a relative `"url": "/jsonrpc"`.
   It now returns the absolute https base URL.

`allUsers` invoker cannot be granted — org policy (domain-restricted sharing) rejects it with
`One or more users named in the policy do not belong to a permitted customer`.

After the URL fix the chat still returned 404, and Cloud Run request logs show **no Gemini request
at all** (only curl and browser traffic). The service agent grant to
`service-227017598651@gcp-sa-discoveryengine.iam.gserviceaccount.com` is not the identity Gemini
uses for Custom-A2A calls.

Root cause: the agent registration has **no `authorizationConfig`**, so Gemini sends no credential
to an IAM-protected Cloud Run service. For Custom-A2A, Gemini runs a server-side OAuth2
authorization-code flow and injects the resulting user token as `Authorization: Bearer ya29...`.
With the `cloud-platform` scope, Cloud Run IAM accepts that user token provided the user holds
`roles/run.invoker`.

Current `roles/run.invoker` holders on the service:
`group:app_sso_gcp_sinch_agent_axdx_AP@groups.on.sinch.com`, `user:jesake@on.sinch.com`,
`serviceAccount:service-227017598651@gcp-sa-discoveryengine.iam.gserviceaccount.com`.

Relevant to DEVEXP-1545: once this is wired, the `Authorization` header Gemini sends is a **Google
user OAuth access token** (`ya29...`), not a Sinch JWT. The dump will confirm the token kind.

## What a non-Gemini smoke call showed (curl + user identity token)

This is **not** a Gemini user session. It only proves the dump works and that header names survive into both dump kinds.

Injected on the request: `x-agent-id: smoke-order-id`, JSON-RPC `params.metadata.probe=true`.

| Field | Observed |
| :--- | :--- |
| `http.headers.x-agent-id` | `smoke-order-id` (present only because the smoke client sent it) |
| `executor.call_context.headers.x-agent-id` | same |
| `session.state` | empty (`state_keys: []`) |
| HTTP `Authorization` | Google identity JWT (`iss=https://accounts.google.com`, `aud=32555940559.apps.googleusercontent.com`, `sub=115771972572415497384`) — **not** a Sinch token |
| JSON-RPC `params.metadata` | only what the caller sent (`probe: true`) — no `orderId` |

## Mapping (fill after a real Gemini chat on `gemini-auth-v2-dump`)

| What | Ticket | Expected MCP header | Found at |
| :--- | :--- | :--- | :--- |
| Order ID | DEVEXP-1544 | `x-agent-id` | *Not observed from Gemini yet.* Dump will surface it at `headers.x-agent-id` and/or JSON-RPC `params` / `session.state` (`orderId` / `order_id`). Smoke proved HTTP headers are copied into `call_context.state.headers`. |
| Sinch auth token | DEVEXP-1545 | `Authorization` | *Not observed from Gemini yet.* Smoke `Authorization` was a Google identity JWT (`accounts.google.com`), not Sinch. After a Gemini turn, compare header JWT `iss`/`aud` vs `session.state.sinch_token` (device-flow token the agent stores itself). |

## Not found (so far)

- No Gemini-injected `x-agent-id` / `orderId` / `order_id` (smoke header was client-supplied)
- No Sinch JWT in `session.state` on a fresh session
- No Agent Engine `call_context` extras

Do not paste live tokens into tickets. Record key/header names, token kind, and JWT claims `iss` / `aud` / `sub` only.

## After you send one Gemini turn

Re-run the logging command above. If Google injects extras, expect `interesting` hits on:

- `headers.x-agent-id` or `jsonrpc.params.*.orderId`
- `headers.authorization` with a **different** `iss`/`aud` than `https://accounts.google.com` / `32555940559.apps.googleusercontent.com`
