#!/usr/bin/env python3
"""
Posts the ACCOUNT_ACTIVE follow-up path to Slack: GET the real account, skip
POST because signup is already APPROVED, then notify.

Does not import main.py (no Pub/Sub, no live subscription).

Usage:
    python marketplace-dashboard/tests/test_slack_account_skip.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

DASHBOARD_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(DASHBOARD_DIR, ".env"))
except ImportError:
    print("ℹ️ python-dotenv not installed — relying on the shell environment only.")

os.environ["AUTO_APPROVE"] = "true"

gcp_creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
if gcp_creds_json:
    creds_file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    creds_file.write(gcp_creds_json)
    creds_file.close()
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_file.name

sys.path.insert(0, DASHBOARD_DIR)
import procurement  # noqa: E402
import slack  # noqa: E402

if not slack.WEBHOOK_URL:
    print("❌ SLACK_WEBHOOK_URL unset — nothing to post.")
    sys.exit(1)

ACCOUNT = "7179646d-32af-4c0b-9678-eacbc71063ce"
ENTITLEMENT = "6d00c708-40f3-446d-9552-d62974ae7210"

print(f"💬 Slack configured: {bool(slack.WEBHOOK_URL)}")
print(f"AUTO_APPROVE={procurement.AUTO_APPROVE}")

# 1. Notify-only, same as offer accepted.
slack.notify(
    "ENTITLEMENT_OFFER_ACCEPTED",
    ENTITLEMENT,
    "N/A",
    {"entitlement": {"id": ENTITLEMENT}, "providerId": "sinch-build"},
)

# 2. The follow-up ACCOUNT_ACTIVE that used to 400.
result = procurement.approve_account_if_signup_pending(ACCOUNT)
print(f"gated result: {result}")
slack.notify(
    "ACCOUNT_ACTIVE",
    "N/A",
    ACCOUNT,
    {
        "eventId": "APPROVE_ACCOUNT-test-skip",
        "eventType": "ACCOUNT_ACTIVE",
        "account": {"id": ACCOUNT},
        "providerId": "sinch-build",
    },
    result,
)

if result.get("skipped") and result.get("ok"):
    print("\n✅ Posted to Slack. ACCOUNT_ACTIVE should say skipped — signup not pending (not FAILED 400).")
    sys.exit(0)

print("\n⚠️ Unexpected gated result — check Slack and the print above.")
sys.exit(1)
