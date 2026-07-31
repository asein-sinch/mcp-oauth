#!/usr/bin/env python3
"""
Smoke-tests the Slack notifier without GCP, Pub/Sub or a service account.

Reads SLACK_WEBHOOK_URL from the environment or from marketplace-dashboard/.env.

Usage:
    python marketplace-dashboard/tests/test_slack_notify.py
    SLACK_WEBHOOK_URL='https://hooks.slack.com/triggers/...' python marketplace-dashboard/tests/test_slack_notify.py
"""

import os
import sys

DASHBOARD_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)

# Load marketplace-dashboard/.env before importing slack, which reads the URL at import time.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(DASHBOARD_DIR, ".env"))
except ImportError:
    print("ℹ️ python-dotenv not installed — relying on the shell environment only.")

sys.path.insert(0, DASHBOARD_DIR)
import slack  # noqa: E402

if not slack.WEBHOOK_URL:
    sys.exit(
        "SLACK_WEBHOOK_URL is not set — nothing would be sent.\n"
        f"Set it in the shell, or add it to {os.path.join(DASHBOARD_DIR, '.env')}"
    )

slack.notify(
    event_type="ENTITLEMENT_CREATION_REQUESTED",
    entitlement_id="ent-test-123",
    account_id="acct-test-456",
    payload={"entitlement": {"product": "sinch-agent", "plan": "flat_fee_plan"}},
    approval_result={"ok": True, "status": 200, "detail": "approved (simulated)"},
)

print("Sent — check #ax-team.")
