#!/usr/bin/env python3
"""
Smoke-tests the Procurement API plumbing against a deliberately non-existent
entitlement ID. Nothing real is approved.

Usage:
    AUTO_APPROVE=true python marketplace-dashboard/tests/test_procurement.py

AUTO_APPROVE must be true or _post() short-circuits and the test proves nothing.
Safe here precisely because the ID does not exist.

Expected outcomes:
    404  PASS  - auth worked, provider path resolved, ID simply not found
    403        - SA lacks the Procurement role
    401        - credentials rejected
    400        - PROCUREMENT_PROVIDER_ID likely wrong
      0        - no credentials found (run: gcloud auth application-default login)
"""

import json
import os
import sys
import tempfile
import uuid

DASHBOARD_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)

# Load .env before importing procurement, which reads its config at import time.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(DASHBOARD_DIR, ".env"))
except ImportError:
    print("ℹ️ python-dotenv not installed — relying on the shell environment only.")

# Same bootstrap as main.py:22-31, so this test authenticates as the identity
# production uses rather than whatever gcloud ADC happens to hold.
gcp_creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
if gcp_creds_json:
    creds_file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    creds_file.write(gcp_creds_json)
    creds_file.close()
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_file.name
    print(f"🔑 Using GOOGLE_CREDENTIALS_JSON ({json.loads(gcp_creds_json).get('client_email')})")
elif os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
    print(f"🔑 Using GOOGLE_APPLICATION_CREDENTIALS={os.environ['GOOGLE_APPLICATION_CREDENTIALS']}")
else:
    print("🔑 Using gcloud application-default credentials (your user, not the producer SA).")

sys.path.insert(0, DASHBOARD_DIR)
import procurement  # noqa: E402

print(f"provider id : {procurement.PROVIDER_ID}")
print(f"auto-approve: {procurement.AUTO_APPROVE}")
if not procurement.AUTO_APPROVE:
    print("\n⚠️ AUTO_APPROVE is off — the call will be skipped and prove nothing.")
    print("   Re-run with: AUTO_APPROVE=true python marketplace-dashboard/tests/test_procurement.py")

fake_id = f"does-not-exist-{uuid.uuid4().hex[:8]}"
print(f"\nCalling approve_entitlement({fake_id!r})...\n")

result = procurement.approve_entitlement(fake_id)
print(f"\nresult: {result}")

if result["status"] == 404:
    print("✅ PASS — authentication and provider path resolve.")
else:
    print("⚠️ Not the expected 404 — see the status table in this file's docstring.")
