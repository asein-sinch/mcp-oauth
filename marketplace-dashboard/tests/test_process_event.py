#!/usr/bin/env python3
"""
Drives the full event path - persist, approve, notify - without Pub/Sub.

Deliberately avoids a subscription: `marketplace-events` is bound to the
production topic, so a local subscriber would compete with Sliplane for real
messages. This calls main.process_event() directly instead.

Writes to a throwaway DB so the real dashboard database stays clean.

Usage:
    AUTO_APPROVE=false python marketplace-dashboard/tests/test_process_event.py
"""

import os
import sys
import tempfile
import uuid

DASHBOARD_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(DASHBOARD_DIR, ".env"))
except ImportError:
    print("ℹ️ python-dotenv not installed — relying on the shell environment only.")

# Redirect the DB before importing main, which initialises it at import time.
scratch_db = os.path.join(tempfile.gettempdir(), f"marketplace-test-{uuid.uuid4().hex[:8]}.db")
os.environ["DB_PATH"] = scratch_db
print(f"🗄️ Using throwaway DB: {scratch_db}")

# Point the subscriber at a name that does not exist. Importing main starts the
# Pub/Sub worker thread, and the real SUBSCRIPTION_ID is bound to the production
# topic - a local subscriber would compete with Sliplane for live messages.
os.environ["SUBSCRIPTION_ID"] = f"test-no-such-subscription-{uuid.uuid4().hex[:8]}"

sys.path.insert(0, DASHBOARD_DIR)
import main  # noqa: E402

print(f"🚫 Subscriber pointed at a non-existent subscription: {main.SUBSCRIPTION_ID}")

fake_entitlement = f"ent-test-{uuid.uuid4().hex[:8]}"
event = {
    "eventId": f"test-event-{uuid.uuid4().hex[:8]}",
    "eventType": "ENTITLEMENT_CREATION_REQUESTED",
    "entitlement": {
        "id": fake_entitlement,
        "product": "sinchagent.endpoints.sinch-build.cloud.goog",
        "plan": "flat_fee_plan",
        "state": "ENTITLEMENT_ACTIVATION_REQUESTED",
    },
    "account": {"id": f"acct-test-{uuid.uuid4().hex[:8]}"},
}

print(f"\n--- process_event({event['eventType']}) ---\n")
result = main.process_event(event)
print(f"\napproval result: {result}")

conn = main.get_db_connection()
rows = conn.execute("SELECT event_type, entitlement_id, account_id FROM events").fetchall()
conn.close()

print(f"\nrows persisted: {len(rows)}")
for row in rows:
    print(f"  {dict(row)}")

if len(rows) == 1 and rows[0]["entitlement_id"] == fake_entitlement:
    print("\n✅ PASS — event persisted. Check #ax-team for the Slack message.")
else:
    print("\n❌ FAIL — event was not persisted as expected.")

os.remove(scratch_db)
