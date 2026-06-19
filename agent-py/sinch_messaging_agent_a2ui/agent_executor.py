"""Agent executor for Sinch Messaging Agent with A2UI validation and per-user Sinch auth."""

import json
import logging
import os
import time
import httpx
from a2a import types
from a2a import utils
from a2a.server import agent_execution
from google.adk.events.event import Event
from google.adk.events.event_actions import EventActions
from a2a.server import events
from a2a.server import tasks
from a2a.utils import errors as a2a_errors
from . import a2ui_schema
from google.adk.agents.llm_agent import Agent
from google.adk.tools import McpToolset
from google.adk.tools.mcp_tool import StreamableHTTPConnectionParams
from google.adk import runners
from google.adk.artifacts import in_memory_artifact_service
from google.adk.memory import in_memory_memory_service
from google.adk.sessions import in_memory_session_service
from google.adk.sessions.vertex_ai_session_service import VertexAiSessionService
from google.genai import types as genai_types
import jsonschema

logger = logging.getLogger(__name__)

# ── Auth server config ────────────────────────────────────────────────────────
SINCH_AUTH_SERVER = os.environ.get(
    "SINCH_AUTH_SERVER_URL", "https://asein-sinch-oauth-server.sliplane.app"
)
SINCH_DEVICE_CLIENT_ID = os.environ.get("SINCH_DEVICE_CLIENT_ID", "sinch-agent")
MCP_JWT_URL = os.environ.get(
    "MCP_SERVER_URL", "https://asein-sinch-mcp-jwt.sliplane.app/mcp"
)
# All surface IDs the LLM may use (must match the templates in agent.py).
_KNOWN_SURFACE_IDS = [
    "srf_welcome",
    "srf_ob1", "srf_ob2", "srf_ob3",
    "srf_ob_warn", "srf_ob_testers", "srf_ob_done",
    "srf_campaign", "srf_campaign_send",
    "srf_insights",
]


def _uniquify_surface_ids(a2ui_messages: list, ts: int) -> list:
  """Replace every known static surfaceId with a timestamp-suffixed version.

  The LLM outputs stable base IDs (e.g. 'srf_campaign'). This function rewrites
  them to 'srf_campaign_<ts>' so each LLM turn produces a distinct A2UI surface
  and never overwrites a previous card in the same conversation.
  """
  raw = json.dumps(a2ui_messages)
  for sid in _KNOWN_SURFACE_IDS:
    # Match the exact quoted string to avoid partial replacements.
    raw = raw.replace(f'"{sid}"', f'"{sid}_{ts}"')
  return json.loads(raw)


# ── A2UI auth card (rendered directly, no LLM needed) ────────────────────────

def _build_auth_card(user_code: str, verification_uri: str) -> tuple[dict, str]:
  """Returns (A2UI JSON payload, surface_id) for the Sinch authentication prompt.
  A unique timestamp suffix ensures each invocation creates a NEW surface
  instead of overwriting the previous auth card in the conversation.
  """
  surface_id = f"srf_sinch_auth_{int(time.time())}"
  return {
      "a2ui_messages": [
          {"beginRendering": {"surfaceId": surface_id, "root": "auth_card"}},
          {
              "surfaceUpdate": {
                  "surfaceId": surface_id,
                  "components": [
                      {"id": "auth_card", "component": {"Card": {"child": "auth_col"}}},
                      {
                          "id": "auth_col",
                          "component": {
                              "Column": {
                                  "children": {
                                      "explicitList": [
                                          "auth_title",
                                          "auth_sub",
                                          "code_label",
                                          "code_box",
                                          "auth_steps",
                                          "auth_done_btn",
                                      ]
                                  }
                              }
                          },
                      },
                      {
                          "id": "auth_title",
                          "component": {
                              "Text": {
                                  "text": {"literalString": "🔐 Connect Your Sinch Account"},
                                  "usageHint": "h2",
                              }
                          },
                      },
                      {
                          "id": "auth_sub",
                          "component": {
                              "Text": {
                                  "text": {
                                      "literalString": (
                                          "To access your Sinch project, please authenticate "
                                          "using the one-time code below."
                                      )
                                  }
                              }
                          },
                      },
                      {
                          "id": "code_label",
                          "component": {
                              "Text": {
                                  "text": {"literalString": "Your one-time code:"},
                                  "usageHint": "label",
                              }
                          },
                      },
                      {
                          "id": "code_box",
                          "component": {
                              "Text": {
                                  "text": {"literalString": f"🔑  {user_code}"},
                                  "usageHint": "h3",
                              }
                          },
                      },
                      {
                          "id": "auth_steps",
                          "component": {
                              "Text": {
                                  "text": {
                                      "literalString": (
                                          f"1. Open: {verification_uri}\n"
                                          f"2. Enter code: {user_code}\n"
                                          "3. Sign in with your Sinch credentials\n"
                                          "4. Click the button below when done"
                                      )
                                  }
                              }
                          },
                      },
                      {
                          "id": "auth_done_btn",
                          "component": {
                              "Button": {
                                  "child": "auth_done_txt",
                                  "primary": True,
                                  "action": {
                                      "name": "submit",
                                      "context": [
                                          {
                                              "key": "message",
                                              "value": {
                                                  "literalString": "I have connected my Sinch account"
                                              },
                                          }
                                      ],
                                  },
                              }
                          },
                      },
                      {
                          "id": "auth_done_txt",
                          "component": {
                              "Text": {
                                  "text": {"literalString": "✅ I've Connected My Account"}
                              }
                          },
                      },
                  ],
              }
          },
      ]
  }, surface_id


class AdkAgentToA2AExecutor(agent_execution.AgentExecutor):
  """An agent executor for the Sinch Messaging Agent A2UI implementation."""

  def __init__(self):
    # Prepare A2UI schema validator
    try:
      single_message_schema = json.loads(a2ui_schema.A2UI_SCHEMA)
      self.a2ui_schema_object = {
          "type": "array",
          "items": single_message_schema,
      }
      logger.info("[DEBUG] A2UI_SCHEMA successfully loaded.")
    except Exception as e:
      logger.error("[DEBUG] Failed to parse A2UI_SCHEMA: %s", e)
      self.a2ui_schema_object = None

    # Session service — persists across container replicas on Agent Engine.
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    agent_engine_id = (
        os.environ.get("SINCH_AGENT_ENGINE_ID")       # explicit env var (non-reserved)
        or os.environ.get("K_SERVICE")                 # fallback: Cloud Run service name
    )

    if project and agent_engine_id:
      logger.info(
          "[DEBUG] Using VertexAiSessionService (project=%s, location=%s, engine=%s)",
          project, location, agent_engine_id,
      )
      self._session_svc = VertexAiSessionService(
          project=project,
          location=location,
          agent_engine_id=agent_engine_id,
      )
    else:
      logger.info("[DEBUG] Falling back to InMemorySessionService (local dev)")
      self._session_svc = in_memory_session_service.InMemorySessionService()

    self._user_id = "remote_agent"
    self._app_name = "sinch_messaging_agent"

  # ── Runner factory ────────────────────────────────────────────────────────
  def _create_runner(self, sinch_token: str | None) -> runners.Runner | None:
    """Create a Runner whose MCP toolset carries the user's Bearer token.
    Returns None on failure.
    """
    try:
      from sinch_messaging_agent_a2ui.agent import root_agent as base_agent

      headers = {}
      if sinch_token:
        headers["Authorization"] = f"Bearer {sinch_token}"

      mcp_toolset = McpToolset(
          connection_params=StreamableHTTPConnectionParams(
              url=MCP_JWT_URL,
              timeout=15.0,
              headers=headers,
          ),
      )

      from google.adk.agents.llm_agent import Agent as LLMAgent
      agent = LLMAgent(
          model=base_agent.model,
          name=base_agent.name,
          description=base_agent.description,
          instruction=base_agent.instruction,
          tools=[mcp_toolset],
      )

      return runners.Runner(
          app_name=self._app_name,
          agent=agent,
          session_service=self._session_svc,
          artifact_service=in_memory_artifact_service.InMemoryArtifactService(),
          memory_service=in_memory_memory_service.InMemoryMemoryService(),
      )
    except Exception as e:
      logger.error("[RUNNER] Failed to create runner: %s", e)
      return None

  # ── Session persistence helper ───────────────────────────────────────────
  async def _persist_state(self, session, delta: dict) -> None:
    """Persist state changes to the session service.
    Falls back to in-memory-only if the remote persist fails (e.g. invalid session ID).
    """
    for k, v in delta.items():
      if v is None:
        session.state.pop(k, None)
      else:
        session.state[k] = v
    try:
      event = Event(
          author="agent",
          actions=EventActions(state_delta=delta),
      )
      await self._session_svc.append_event(session, event)
      logger.info("[AUTH] State delta persisted to session service: %s", list(delta.keys()))
    except Exception as e:
      logger.warning(
          "[AUTH] Could not persist state to session service (in-memory only): %s", e
      )

  # ── Sinch auth helpers ────────────────────────────────────────────────────
  async def _check_cached_token(self) -> str | None:
    """Check auth server for a cached token (survives context_id changes between GE turns)."""
    try:
      async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(
            f"{SINCH_AUTH_SERVER}/token/cached",
            params={"client_id": SINCH_DEVICE_CLIENT_ID},
        )
        if resp.status_code == 200:
          token = resp.json().get("access_token")
          if token:
            logger.info("[AUTH] ✅ Retrieved cached token from auth server.")
            return token
    except Exception as e:
      logger.warning("[AUTH] Could not check cached token: %s", e)
    return None

  async def _initiate_device_auth(self, context_id: str) -> dict | None:
    """Call /device_authorization on the auth server.
    Passes context_id so the auth server returns the SAME user_code for this
    conversation on every call (idempotent — no session state needed).
    Returns parsed JSON or None.
    """
    try:
      async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{SINCH_AUTH_SERVER}/device_authorization",
            data={"client_id": SINCH_DEVICE_CLIENT_ID, "context_id": context_id},
        )
        if resp.status_code == 200:
          return resp.json()
        logger.error("[AUTH] device_authorization failed: %s %s", resp.status_code, resp.text)
    except Exception as e:
      logger.error("[AUTH] device_authorization error: %s", e)
    return None

  async def _poll_device_token(self, device_code: str) -> str | None:
    """Poll /token for a device_code grant. Returns access_token or None if pending."""
    try:
      async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{SINCH_AUTH_SERVER}/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": SINCH_DEVICE_CLIENT_ID,
            },
        )
        if resp.status_code == 200:
          return resp.json().get("access_token")
        body = resp.json()
        if body.get("error") == "authorization_pending":
          return None  # user hasn't logged in yet
        logger.warning("[AUTH] poll_device_token unexpected response: %s", body)
    except Exception as e:
      logger.error("[AUTH] poll_device_token error: %s", e)
    return None

  async def _send_auth_card(
      self,
      updater: tasks.TaskUpdater,
      user_code: str,
      verification_uri: str,
  ) -> None:
    """Send the auth card A2UI response without invoking the LLM."""
    await updater.start_work()
    auth_json, _surface_id = _build_auth_card(user_code, verification_uri)
    a2ui_messages = auth_json["a2ui_messages"]

    parts = [
        types.Part(
            root=types.TextPart(
                text=(
                    f"To access your Sinch account, please authenticate:\n"
                    f"1. Open: {verification_uri}\n"
                    f"2. Enter code: **{user_code}**\n"
                    "3. Sign in with your Sinch credentials\n"
                    "4. Click 'I've Connected My Account' when done."
                )
            )
        )
    ]
    begin = next((m for m in a2ui_messages if "beginRendering" in m), None)
    if begin:
      parts.append(
          types.Part(
              root=types.DataPart(
                  data=begin,
                  metadata={"mimeType": "application/json+a2ui"},
              )
          )
      )
    for msg in a2ui_messages:
      if "beginRendering" in msg:
        continue
      parts.append(
          types.Part(
              root=types.DataPart(
                  data=msg,
                  metadata={"mimeType": "application/json+a2ui"},
              )
          )
      )
    await updater.add_artifact(parts, name="response")
    await updater.complete()

  # ── Main execute ──────────────────────────────────────────────────────────
  async def execute(
      self,
      context: agent_execution.RequestContext,
      event_queue: events.EventQueue,
  ) -> None:
    try:
      await self._execute_inner(context, event_queue)
    except Exception as e:
      logger.error("[EXECUTOR] Unhandled exception in execute(): %s", e, exc_info=True)
      # Best-effort: report a failure so GE doesn't hang indefinitely.
      try:
        task = context.current_task
        if task:
          updater = tasks.TaskUpdater(event_queue, task.id, task.context_id)
          await updater.start_work()
          await updater.add_artifact(
              [types.Part(root=types.TextPart(text=f"⚠️ Internal error: {e}"))],
              name="error",
          )
          await updater.complete()
      except Exception:
        pass

  async def _execute_inner(
      self,
      context: agent_execution.RequestContext,
      event_queue: events.EventQueue,
  ) -> None:
    query = context.get_user_input()
    task = context.current_task
    logger.info("[DEBUG] Query: %s", query)

    if not task:
      if not context.message:
        return
      task = utils.new_task(context.message)
      await event_queue.enqueue_event(task)

    updater = tasks.TaskUpdater(event_queue, task.id, task.context_id)
    session_id = task.context_id

    session = await self._session_svc.get_session(
        app_name=self._app_name,
        user_id=self._user_id,
        session_id=session_id,
    )
    if session is None:
      session = await self._session_svc.create_session(
          app_name=self._app_name,
          user_id=self._user_id,
          state={},
          session_id=session_id,
      )

    # 1. SESSION RECOVERY: Parse userAction inputs/context from incoming parts
    try:
      if hasattr(context, "message") and context.message and hasattr(context.message, "parts"):
        for part in context.message.parts:
          if hasattr(part, "root") and hasattr(part.root, "data"):
            data = part.root.data
            if isinstance(data, dict) and "userAction" in data:
              user_action = data["userAction"]

              raw_context = user_action.get("context", [])
              ctx_dict = {}
              if isinstance(raw_context, list):
                for item in raw_context:
                  if isinstance(item, dict) and "key" in item:
                    ctx_dict[item["key"]] = item.get("value", "")
              elif isinstance(raw_context, dict):
                ctx_dict = raw_context

              if "message" in ctx_dict:
                query = ctx_dict["message"]

              for k, v in ctx_dict.items():
                if k != "message" and v:
                  session.state[k] = v
                  logger.info("[DEBUG] Recovered context key %s: %s", k, v)

              for item in user_action.get("inputs", []):
                if item.get("id") and item.get("value") is not None:
                  session.state[item["id"]] = item["value"]
                  logger.info("[DEBUG] Recovered input %s: %s", item["id"], item["value"])

    except Exception as e:
      logger.warning("[DEBUG] Context recovery failed: %s", e)

    # ── 2. SINCH AUTH GATE ────────────────────────────────────────────────
    # Strategy: context_id (always available from the task, no session lookup)
    # is passed to /device_authorization as a stable key. The auth server
    # returns the SAME user_code for the same context_id across all A2A turns,
    # so we never need to persist sinch_device_code in session state.
    sinch_token: str | None = session.state.get("sinch_token")

    # Check the auth server's token cache first — this survives context_id
    # changes between button clicks in GE (each click may use a new context_id).
    if not sinch_token:
      sinch_token = await self._check_cached_token()
      if sinch_token:
        await self._persist_state(session, {"sinch_token": sinch_token})

    if not sinch_token:
      logger.info("[AUTH] No Sinch token — calling device_authorization (idempotent).")
      device_resp = await self._initiate_device_auth(context_id=session_id)
      if not device_resp:
        await updater.start_work()
        await updater.add_artifact(
            [types.Part(root=types.TextPart(
                text="⚠️ Unable to reach the Sinch auth server. Please try again."
            ))],
            name="response",
        )
        await updater.complete()
        return

      device_code = device_resp["device_code"]
      user_code = device_resp["user_code"]
      verification_uri = device_resp["verification_uri"]

      # Try to exchange the device_code for a token (user may have already logged in).
      sinch_token = await self._poll_device_token(device_code)

      if sinch_token:
        logger.info("[AUTH] ✅ Token obtained — persisting to session.")
        await self._persist_state(session, {"sinch_token": sinch_token})
      else:
        # Still pending — show the auth card with the stable user_code.
        logger.info("[AUTH] Auth pending — showing auth card (user_code=%s).", user_code)
        await self._send_auth_card(updater, user_code, verification_uri)
        return

    # ── 3. STATE INJECTION: Append session state to query ────────────────
    state_str = ", ".join([
        f"{k}={v}" for k, v in session.state.items()
        if k not in ("sinch_token", "sinch_device_code", "sinch_user_code", "sinch_verification_uri")
    ])
    if state_str:
      query = f"{query} [Collected data: {state_str}]"
      logger.info("[DEBUG] Injected state to query: %s", query)

    # ── 4. LLM CALL with per-user runner ─────────────────────────────────
    runner = self._create_runner(sinch_token)
    if runner is None:
      await updater.start_work()
      await updater.add_artifact(
          [types.Part(root=types.TextPart(
              text="⚠️ Failed to initialise the Sinch MCP connection. Please try again."
          ))],
          name="error",
      )
      await updater.complete()
      return

    current_query_text = query
    max_retries = 1
    attempt = 0

    await updater.start_work()

    while attempt <= max_retries:
      attempt += 1
      content = genai_types.Content(
          role="user", parts=[{"text": current_query_text}]
      )
      final_response_content = None

      logger.info("[DEBUG] attempt: %s", attempt)

      try:
        async for event in runner.run_async(
            user_id=self._user_id, session_id=session.id, new_message=content
        ):
          if event.is_final_response():
            if (
                event.content
                and event.content.parts
                and event.content.parts[0].text
            ):
              final_response_content = "\n".join(
                  [p.text for p in event.content.parts if p.text]
              )
              logger.info(
                  "[DEBUG] Final response content: %s", final_response_content
              )
      except Exception as e:
        await updater.failed(
            message=utils.new_agent_text_message(
                f"Task failed with error: {str(e)}"
            )
        )
        return

      if final_response_content is None:
        if attempt <= max_retries:
          current_query_text = "I received no response. Please try again."
          continue
        else:
          await updater.failed(
              message=utils.new_agent_text_message("No response generated.")
          )
          return

      is_valid = False
      error_message = ""
      json_string_cleaned = "[]"
      text_part = final_response_content

      if "---a2ui_JSON---" not in final_response_content:
        error_message = "Delimiter '---a2ui_JSON---' not found."
      else:
        try:
          text_part, json_string = final_response_content.split(
              "---a2ui_JSON---", 1
          )
          json_string_cleaned = (
              json_string.strip().lstrip("```json").rstrip("```").strip()
          )
          if not json_string_cleaned:
            json_string_cleaned = "[]"

          parsed_json_obj = json.loads(json_string_cleaned)
          parsed_json = parsed_json_obj.get("a2ui_messages", [])

          # Make every surfaceId unique so this turn's cards never overwrite
          # cards from previous turns that used the same template.
          ts = int(time.time())
          parsed_json = _uniquify_surface_ids(parsed_json, ts)
          json_string_cleaned = json.dumps({"a2ui_messages": parsed_json})

          logger.info("[DEBUG] Parsed JSON array: %s", parsed_json)

          if self.a2ui_schema_object:
            jsonschema.validate(
                instance=parsed_json, schema=self.a2ui_schema_object
            )
          is_valid = True
        except Exception as e:
          error_message = f"Validation failed: {str(e)}"

      if is_valid:
        parts = []
        if text_part.strip():
          parts.append(types.Part(root=types.TextPart(text=text_part.strip())))

        logger.info("[DEBUG] UI JSON: %s", json_string_cleaned)
        json_data = json.loads(json_string_cleaned).get("a2ui_messages", [])

        begin_rendering_msg = next((m for m in json_data if "beginRendering" in m), None)
        if begin_rendering_msg:
          parts.append(
              types.Part(
                  root=types.DataPart(
                      data=begin_rendering_msg,
                      metadata={"mimeType": "application/json+a2ui"},
                  )
              )
          )

        for message in json_data:
          if "beginRendering" in message:
            continue
          parts.append(
              types.Part(
                  root=types.DataPart(
                      data=message,
                      metadata={"mimeType": "application/json+a2ui"},
                  )
              )
          )

        logger.info("[DEBUG] Generated A2A Parts: %s", parts)
        await updater.add_artifact(parts, name="response")
        await updater.complete()
        return
      else:
        if attempt <= max_retries:
          current_query_text = (
              f"Your previous response was invalid. {error_message} You MUST"
              " generate a valid response that strictly follows the A2UI JSON"
              f" SCHEMA. Please retry the original request: '{query}'"
          )
          logger.warning(
              "[DEBUG] Retrying due to validation error: %s", error_message
          )
          continue
        else:
          await updater.add_artifact(
              [
                  types.Part(
                      root=types.TextPart(
                          text=(
                              "I encountered an error generating the UI:"
                              f" {error_message}. Here is the raw response:"
                              f" {final_response_content}"
                          )
                      )
                  )
              ],
              name="error_response",
          )
          await updater.complete()
          return

  async def cancel(
      self,
      context: agent_execution.RequestContext,
      event_queue: events.EventQueue,
  ) -> None:
    raise a2a_errors.ServerError(error=types.UnsupportedOperationError())
