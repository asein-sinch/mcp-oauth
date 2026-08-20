#!/usr/bin/env python3
"""
Tests ACCOUNT_ACTIVE approve gating: POST only when GET shows signup PENDING.

No Pub/Sub. Mocks Procurement HTTP so this cannot approve a real account.

Usage:
    python marketplace-dashboard/tests/test_signup_pending.py
"""

import os
import sys
from unittest.mock import patch

DASHBOARD_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)
os.environ["AUTO_APPROVE"] = "true"
sys.path.insert(0, DASHBOARD_DIR)

import procurement  # noqa: E402

ACCOUNT = "7179646d-32af-4c0b-9678-eacbc71063ce"
failed = 0


def check(name, cond):
    global failed
    if cond:
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}")


print("--- signup_is_pending ---")
check(
    "PENDING signup",
    procurement.signup_is_pending(
        {"approvals": [{"name": "signup", "state": "PENDING"}]}
    ),
)
check(
    "APPROVED signup",
    not procurement.signup_is_pending(
        {"approvals": [{"name": "signup", "state": "APPROVED"}]}
    ),
)
check("empty approvals", not procurement.signup_is_pending({"approvals": []}))
check("missing approvals", not procurement.signup_is_pending({}))

print("\n--- approve_account_if_signup_pending ---")

with patch.object(
    procurement,
    "get_account",
    return_value={
        "ok": True,
        "status": 200,
        "body": {"approvals": [{"name": "signup", "state": "APPROVED"}]},
    },
) as get_mock, patch.object(procurement, "approve_account") as post_mock:
    result = procurement.approve_account_if_signup_pending(ACCOUNT)
    check("APPROVED skips POST", result.get("skipped") is True and post_mock.call_count == 0)
    check("APPROVED still ok", result.get("ok") is True)
    check("GET was called", get_mock.call_count == 1)
    print(f"    result: {result}")

with patch.object(
    procurement,
    "get_account",
    return_value={
        "ok": True,
        "status": 200,
        "body": {"approvals": [{"name": "signup", "state": "PENDING"}]},
    },
) as get_mock, patch.object(
    procurement,
    "approve_account",
    return_value={"ok": True, "skipped": False, "status": 200, "detail": "approved"},
) as post_mock:
    result = procurement.approve_account_if_signup_pending(ACCOUNT)
    check("PENDING calls POST", post_mock.call_count == 1)
    check("PENDING POST 200", result.get("status") == 200 and result.get("ok") is True)
    print(f"    result: {result}")

result = procurement.approve_account_if_signup_pending("N/A")
check("N/A skips GET/POST", result.get("skipped") is True and "no account id" in result.get("detail", ""))

print()
if failed:
    print(f"❌ {failed} check(s) failed")
    sys.exit(1)
print("✅ PASS — GET-then-conditional-POST matches the plan.")
