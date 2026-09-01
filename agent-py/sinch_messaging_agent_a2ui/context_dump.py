"""Redacted dumps of HTTP + A2A RequestContext + session for Gemini Auth V2.

Enabled only when DUMP_AGENT_CONTEXT=true. Logs a single JSON blob prefixed
[CONTEXT DUMP]. Never logs full Bearer/JWT/device tokens — JWT payload is
decoded only to record iss / aud / sub / typ.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_DUMP_ENABLED = os.environ.get("DUMP_AGENT_CONTEXT", "").lower() in ("1", "true", "yes")

_SECRET_KEY_RE = re.compile(
    r"(authorization|token|secret|password|jwt|bearer|id_token|access_token|"
    r"refresh_token|device_code|sinch_token|sinch_id_token|api[-_]?key)",
    re.IGNORECASE,
)

_INTERESTING_KEYS = (
    "x-agent-id",
    "orderid",
    "order_id",
    "order-id",
    "authorization",
    "sinch_token",
)


def _dump_enabled() -> bool:
  return os.environ.get("DUMP_AGENT_CONTEXT", "").lower() in ("1", "true", "yes") or _DUMP_ENABLED


def _b64url_decode(segment: str) -> bytes:
  padded = segment + "=" * ((4 - len(segment) % 4) % 4)
  return base64.urlsafe_b64decode(padded.encode("ascii"))


def _jwt_claims(token: str) -> dict[str, Any] | None:
  parts = token.split(".")
  if len(parts) != 3:
    return None
  try:
    payload = json.loads(_b64url_decode(parts[1]))
  except Exception:
    return None
  return {
      "iss": payload.get("iss"),
      "aud": payload.get("aud"),
      "sub": payload.get("sub"),
      "typ": payload.get("typ"),
      "token_kind": "jwt",
  }


def _redact_secret_value(value: Any) -> Any:
  if not isinstance(value, str) or not value:
    return value
  raw = value
  if raw.lower().startswith("bearer "):
    raw = raw[7:].strip()
  claims = _jwt_claims(raw)
  if claims:
    return {"redacted": True, **claims, "length": len(raw)}
  if len(raw) >= 16:
    return {"redacted": True, "token_kind": "opaque", "length": len(raw)}
  return value


def _looks_secret_key(key: str) -> bool:
  return bool(_SECRET_KEY_RE.search(key.replace("-", "_")))


def _sanitize(obj: Any, key_hint: str = "") -> Any:
  if _looks_secret_key(key_hint):
    if isinstance(obj, str):
      return _redact_secret_value(obj)
    if isinstance(obj, dict):
      return {k: _sanitize(v, k) for k, v in obj.items()}
  if isinstance(obj, dict):
    return {str(k): _sanitize(v, str(k)) for k, v in obj.items()}
  if isinstance(obj, (list, tuple)):
    return [_sanitize(v, key_hint) for v in obj]
  if isinstance(obj, (str, int, float, bool)) or obj is None:
    return obj
  try:
    if hasattr(obj, "model_dump"):
      return _sanitize(obj.model_dump(mode="json", exclude_none=True), key_hint)
  except Exception:
    pass
  try:
    return _sanitize(vars(obj), key_hint)
  except Exception:
    return repr(obj)[:500]


def _headers_dict(headers: Any) -> dict[str, Any]:
  if headers is None:
    return {}
  if hasattr(headers, "items"):
    return {str(k).lower(): _sanitize(v, str(k)) for k, v in headers.items()}
  return {}


def _find_interesting(obj: Any, path: str = "") -> list[dict[str, Any]]:
  hits: list[dict[str, Any]] = []

  def walk(node: Any, p: str) -> None:
    if isinstance(node, dict):
      for k, v in node.items():
        key_l = str(k).lower()
        next_p = f"{p}.{k}" if p else str(k)
        if key_l in _INTERESTING_KEYS or any(ik in key_l for ik in _INTERESTING_KEYS):
          hits.append({"path": next_p, "value": _sanitize(v, str(k))})
        walk(v, next_p)
    elif isinstance(node, list):
      for i, v in enumerate(node):
        walk(v, f"{p}[{i}]")

  walk(obj, path)
  return hits


def _emit(kind: str, payload: dict[str, Any]) -> None:
  if not _dump_enabled():
    return
  blob = {
      "kind": kind,
      "interesting": _find_interesting(payload),
      **payload,
  }
  logger.info("[CONTEXT DUMP] %s", json.dumps(blob, default=str, ensure_ascii=False))


def dump_http_request(request: Any, body: Any) -> None:
  """Dump incoming FastAPI/Starlette request (Gemini → Cloud Run)."""
  if not _dump_enabled():
    return
  try:
    headers = _headers_dict(getattr(request, "headers", None))
    _emit(
        "http",
        {
            "method": getattr(request, "method", None),
            "url": str(getattr(request, "url", "")),
            "headers": headers,
            "jsonrpc": _sanitize(body),
        },
    )
  except Exception:
    logger.exception("[CONTEXT DUMP] dump_http_request failed")


def _serialize_message(message: Any) -> Any:
  if message is None:
    return None
  try:
    if hasattr(message, "model_dump"):
      return _sanitize(message.model_dump(mode="json", exclude_none=True))
  except Exception:
    pass
  parts_out = []
  for part in getattr(message, "parts", None) or []:
    root = getattr(part, "root", part)
    entry: dict[str, Any] = {"type": type(root).__name__}
    if hasattr(root, "text"):
      entry["text"] = (root.text or "")[:500]
    if hasattr(root, "data"):
      entry["data"] = _sanitize(root.data)
    if hasattr(root, "metadata"):
      entry["metadata"] = _sanitize(root.metadata)
    parts_out.append(entry)
  return {
      "message_id": getattr(message, "message_id", None),
      "task_id": getattr(message, "task_id", None),
      "context_id": getattr(message, "context_id", None),
      "metadata": _sanitize(getattr(message, "metadata", None)),
      "parts": parts_out,
  }


def _serialize_call_context(call_context: Any) -> Any:
  if call_context is None:
    return None
  state = getattr(call_context, "state", None) or {}
  headers = {}
  if isinstance(state, dict):
    headers = _headers_dict(state.get("headers"))
    state_sanitized = {k: _sanitize(v, k) for k, v in state.items() if k != "headers"}
  else:
    state_sanitized = _sanitize(state)
  return {
      "headers": headers,
      "state": state_sanitized,
      "activated_extensions": list(getattr(call_context, "activated_extensions", []) or []),
      "requested_extensions": list(getattr(call_context, "requested_extensions", []) or []),
  }


def _serialize_session(session: Any) -> Any:
  if session is None:
    return None
  state = getattr(session, "state", None) or {}
  if not isinstance(state, dict):
    state = {}
  return {
      "id": getattr(session, "id", None),
      "user_id": getattr(session, "user_id", None),
      "app_name": getattr(session, "app_name", None),
      "state_keys": sorted(str(k) for k in state.keys()),
      "state": {k: _sanitize(v, str(k)) for k, v in state.items()},
  }


def dump_executor_context(context: Any, session: Any = None) -> None:
  """Dump A2A RequestContext + ADK session inside AdkAgentToA2AExecutor."""
  if not _dump_enabled():
    return
  try:
    task = getattr(context, "current_task", None)
    _emit(
        "executor",
        {
            "user_input": (context.get_user_input() if hasattr(context, "get_user_input") else None),
            "task_id": getattr(task, "id", None) or getattr(context, "task_id", None),
            "context_id": getattr(task, "context_id", None) or getattr(context, "context_id", None),
            "metadata": _sanitize(getattr(context, "metadata", None)),
            "sinch_id_token": _redact_secret_value(getattr(context, "sinch_id_token", None) or ""),
            "call_context": _serialize_call_context(getattr(context, "call_context", None)),
            "message": _serialize_message(getattr(context, "message", None)),
            "session": _serialize_session(session),
        },
    )
  except Exception:
    logger.exception("[CONTEXT DUMP] dump_executor_context failed")


def dump_proxy_context(context: Any) -> None:
  """Dump Agent Engine proxy RequestContext (unused when Gemini hits Cloud Run)."""
  if not _dump_enabled():
    return
  try:
    task = getattr(context, "current_task", None)
    _emit(
        "proxy",
        {
            "user_input": (context.get_user_input() if hasattr(context, "get_user_input") else None),
            "task_id": getattr(task, "id", None),
            "context_id": getattr(task, "context_id", None),
            "call_context": _serialize_call_context(getattr(context, "call_context", None)),
            "message": _serialize_message(getattr(context, "message", None)),
        },
    )
  except Exception:
    logger.exception("[CONTEXT DUMP] dump_proxy_context failed")
