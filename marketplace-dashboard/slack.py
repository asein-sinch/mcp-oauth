"""
Slack notifier for Google Cloud Marketplace events.

Posts a single plain-text message per event to the webhook in SLACK_WEBHOOK_URL.
The webhook is a Slack Workflow Builder "From a webhook" trigger, which accepts
only flat declared variables (a `text` string) - not Block Kit.
"""

import os
from datetime import datetime, timezone

import requests

WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")

EMOJI = {
    "ACCOUNT_ACTIVE": "👤",
    "ENTITLEMENT_CREATION_REQUESTED": "🛒",
    "ENTITLEMENT_ACTIVE": "✅",
    "ENTITLEMENT_PLAN_CHANGE_REQUESTED": "🔄",
    "ENTITLEMENT_SUSPENDED": "⏸️",
    "ENTITLEMENT_PENDING_CANCELLATION": "🕒",
    "ENTITLEMENT_CANCELLED": "⚠️",
}


def build_summary(event_type: str, entitlement_id: str, account_id: str, payload: dict, approval_result: dict = None) -> str:
    """Renders the human-readable message body sent to Slack."""
    lines = [
        f"{EMOJI.get(event_type, '📩')} {event_type}",
        f"entitlement: {entitlement_id}",
        f"account: {account_id}",
    ]

    entitlement = payload.get("entitlement", {}) if isinstance(payload, dict) else {}
    product = entitlement.get("product")
    if product:
        lines.append(f"product: {product}")
    plan = entitlement.get("plan")
    if plan:
        lines.append(f"plan: {plan}")

    if approval_result is not None:
        detail = approval_result.get("detail", "")
        status = approval_result.get("status")
        if approval_result.get("skipped"):
            outcome = f"skipped — {detail}"
        elif approval_result.get("ok"):
            outcome = f"{detail or 'approved'}" + (f" (HTTP {status})" if status else "")
        else:
            outcome = f"FAILED (HTTP {status}) {detail}" if status else f"FAILED — {detail}"
        lines.append(f"auto-approve: {outcome}".rstrip())

    # Labelled UTC: the Sliplane container runs UTC, local runs do not.
    lines.append(f"time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC")

    return "\n".join(lines)


def notify(event_type: str, entitlement_id: str, account_id: str, payload: dict, approval_result: dict = None):
    """
    Posts one Marketplace event to Slack.

    Never raises: this runs inside the Pub/Sub callback, where an escaping
    exception would nack() the message and cause endless redelivery.
    """
    if not WEBHOOK_URL:
        print("ℹ️ SLACK_WEBHOOK_URL unset — skipping Slack notification.")
        return

    try:
        summary = build_summary(event_type, entitlement_id, account_id, payload, approval_result)
        resp = requests.post(WEBHOOK_URL, json={"text": summary}, timeout=10)
        if resp.ok:
            print(f"💬 Slack notified: {event_type} (HTTP {resp.status_code})")
        else:
            print(f"⚠️ Slack rejected notification for {event_type}: HTTP {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"❌ Slack notify failed: {e}")
