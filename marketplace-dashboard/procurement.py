"""
Google Cloud Marketplace Partner Procurement API client.

Answers the Pub/Sub notifications by approving accounts and entitlements, so an
accepted private offer provisions without manual intervention in Producer Portal.

Credentials are the *producer* service account (sinch-build, the project owning
the Marketplace listing) - the same one main.py already configures for Pub/Sub.
"""

import os
import google.auth
from google.auth.transport.requests import AuthorizedSession

BASE = "https://cloudcommerceprocurement.googleapis.com/v1"
PROVIDER_ID = os.getenv("PROCUREMENT_PROVIDER_ID", "sinch-build")
AUTO_APPROVE = os.getenv("AUTO_APPROVE", "true").lower() in ("1", "true", "yes")
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

_session = None


def _get_session() -> AuthorizedSession:
    """Builds the authorized session lazily, so importing never blocks app boot."""
    global _session
    if _session is None:
        credentials, _ = google.auth.default(scopes=SCOPES)
        _session = AuthorizedSession(credentials)
    return _session


def _post(path: str, body: dict) -> dict:
    """POSTs to the Procurement API and normalises the outcome. Never raises."""
    if not AUTO_APPROVE:
        print(f"⏭️ AUTO_APPROVE is off — skipping Procurement POST {path}")
        return {"ok": False, "skipped": True, "status": None, "detail": "AUTO_APPROVE is off"}

    url = f"{BASE}/providers/{PROVIDER_ID}/{path}"
    try:
        resp = _get_session().post(url, json=body, timeout=30)
    except Exception as e:
        print(f"❌ Procurement call failed: {e}")
        return {"ok": False, "skipped": False, "status": None, "detail": str(e)}

    # Pub/Sub is at-least-once, so the same event can arrive twice. A second
    # approve of an already-approved resource is a success, not an alert.
    already_done = resp.status_code in (400, 409) and "approv" in resp.text.lower()
    ok = resp.ok or already_done

    if already_done and not resp.ok:
        detail = "already approved"
    elif ok:
        detail = "approved"
    else:
        detail = resp.text[:300]

    print(f"{'✅' if ok else '❌'} Procurement POST {path}: HTTP {resp.status_code} — {detail}")
    return {"ok": ok, "skipped": False, "status": resp.status_code, "detail": detail}


def approve_account(account_id: str) -> dict:
    """Approves a customer's Marketplace account signup."""
    return _post(f"accounts/{account_id}:approve", {"approvalName": "signup"})


def approve_entitlement(entitlement_id: str) -> dict:
    """Approves a newly requested entitlement (a purchase or accepted private offer)."""
    return _post(f"entitlements/{entitlement_id}:approve", {})
