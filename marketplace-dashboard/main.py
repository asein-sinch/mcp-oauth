import os
import json
import secrets
import sqlite3
import threading
import time
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from fastapi import FastAPI, Form, Request, Depends, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from google.cloud import pubsub_v1
from google.api_core.exceptions import GoogleAPIError

# Must run before importing slack/procurement: both read their config at import
# time. Path is anchored to this file so it works regardless of the working
# directory. No-op in production, where Sliplane sets real env vars (which win).
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import slack
import procurement

# Initialize FastAPI App
app = FastAPI(title="Sinch Marketplace Event Dashboard")

# Setup template directories
templates = Jinja2Templates(directory="templates")

# Configure Google Application Credentials via environment variable JSON if running in external cloud
gcp_creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
if gcp_creds_json:
    try:
        creds_path = "/tmp/sa-key.json"
        with open(creds_path, "w") as f:
            f.write(gcp_creds_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path
        print("🔑 Google Application Credentials configured from GOOGLE_CREDENTIALS_JSON env var.")
    except Exception as e:
        print(f"⚠️ Failed to write GOOGLE_CREDENTIALS_JSON: {e}")

# Configure DB Path (Default to /data/marketplace.db if /data volume is writable, otherwise fallback to local)
default_db = "marketplace.db"
try:
    if os.path.exists("/data") and os.access("/data", os.W_OK):
        default_db = "/data/marketplace.db"
except Exception:
    pass

DB_PATH = os.getenv("DB_PATH", default_db)
PROJECT_ID = os.getenv("PROJECT_ID", "sinch-build")
SUBSCRIPTION_ID = os.getenv("SUBSCRIPTION_ID", "marketplace-events")

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
COOKIE_NAME = "sinch_session"
SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE", "43200"))  # 12h
# Sliplane terminates TLS, so the cookie can be https-only. Overridable for
# local http development.
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() in ("1", "true", "yes")

# Sessions are signed rather than a fixed string: this repo is public, so any
# constant cookie value would be a published credential.
SESSION_SECRET = os.getenv("SESSION_SECRET") or secrets.token_urlsafe(32)
if not os.getenv("SESSION_SECRET"):
    print("⚠️ SESSION_SECRET unset — using a random per-process secret. "
          "Sessions will not survive a restart. Set it in the environment.")
_signer = URLSafeTimedSerializer(SESSION_SECRET, salt="sinch-dashboard-session")

if not ADMIN_PASSWORD:
    print("🚫 ADMIN_PASSWORD is not set — login is disabled until it is configured.")

# ==========================================
# DATABASE LAYER
# ==========================================

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initializes the SQLite database schema."""
    # Ensure parent directory exists if nested
    db_dir = os.path.dirname(DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT UNIQUE NOT NULL,
            event_type TEXT NOT NULL,
            entitlement_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()
    print("🔋 SQLite database initialized successfully.")

# Initialize DB immediately on import
init_db()

def insert_event(event_id: str, event_type: str, entitlement_id: str, account_id: str, payload: str):
    """Inserts a new event into the SQLite DB, ignoring duplicates."""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            "INSERT OR IGNORE INTO events (event_id, event_type, entitlement_id, account_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, event_type, entitlement_id, account_id, payload, now_str)
        )
        conn.commit()
        conn.close()
        print(f"💾 Event stored in database: {event_type} (ID: {event_id})")
    except Exception as e:
        print(f"❌ Database error: {e}")

# ==========================================
# AUTHENTICATION GUARD
# ==========================================

def is_authenticated(request: Request) -> bool:
    """Checks for a validly signed, unexpired session cookie."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return False
    try:
        _signer.loads(token, max_age=SESSION_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False

# ==========================================
# EVENT HANDLING
# ==========================================

def process_event(event: dict, message_id: str = "local") -> Optional[dict]:
    """
    Handles one Marketplace event: persist it, answer it, then notify Slack.

    Kept at module level and free of Pub/Sub types so it can be exercised from a
    test without a subscription. Returns the approval result, or None when the
    event type has no approve action.
    """
    event_id = event.get("eventId", f"msg-{message_id}")
    event_type = event.get("eventType", "UNKNOWN_EVENT")
    entitlement_id = event.get("entitlement", {}).get("id", "N/A")
    account_id = event.get("account", {}).get("id", "N/A")

    print(f"📥 Received Pub/Sub message: {event_type}")

    # Store event in our SQLite DB
    insert_event(
        event_id=event_id,
        event_type=event_type,
        entitlement_id=entitlement_id,
        account_id=account_id,
        payload=json.dumps(event)
    )

    # Answer the notification, so an accepted offer provisions without manual
    # intervention. Other event types are notify-only: nothing to approve.
    result = None
    if event_type == "ACCOUNT_ACTIVE":
        result = procurement.approve_account(account_id)
    elif event_type == "ENTITLEMENT_CREATION_REQUESTED":
        result = procurement.approve_entitlement(entitlement_id)

    slack.notify(event_type, entitlement_id, account_id, event, result)
    return result

# ==========================================
# BACKGROUND PUB/SUB WORKER
# ==========================================

def pubsub_subscriber_worker():
    """Background worker that runs in a thread, pulling messages from GCP Pub/Sub."""
    print("🛰️ Pub/Sub Subscriber Worker thread started...")
    
    # Graceful delay to let the FastAPI server bind and display startup logs first
    time.sleep(2)
    
    while True:
        try:
            subscriber = pubsub_v1.SubscriberClient()
            subscription_path = subscriber.subscription_path(PROJECT_ID, SUBSCRIPTION_ID)
            
            print(f"🔍 Attempting to subscribe to: {subscription_path}")
            
            def callback(message):
                """Transport only: decode, delegate, acknowledge."""
                try:
                    event = json.loads(message.data.decode("utf-8"))
                    process_event(event, message.message_id)
                    message.ack()
                except Exception as e:
                    print(f"❌ Error handling message: {e}")
                    message.nack()

            # Block and listen indefinitely
            streaming_pull_future = subscriber.subscribe(subscription_path, callback=callback)
            with subscriber:
                streaming_pull_future.result()
                
        except GoogleAPIError as g_err:
            print(f"⚠️ Google API Connection Warning: {g_err}")
            print("🕒 Pub/Sub subscription not available yet (waiting for Google verification/Submit). Retrying in 30 seconds...")
            time.sleep(30)
        except Exception as e:
            print(f"💥 Worker Encountered Error: {e}")
            print("🕒 Retrying Pub/Sub connection in 15 seconds...")
            time.sleep(15)

# Launch Background Thread on module load
worker_thread = threading.Thread(target=pubsub_subscriber_worker, daemon=True)
worker_thread.start()

# ==========================================
# HTTP CONTROLLERS (ROUTES)
# ==========================================

@app.get("/", response_class=HTMLResponse)
def root(request: Request):
    """Index redirection based on auth status."""
    if is_authenticated(request):
        return RedirectResponse(url="/dashboard", status_code=303)
    return RedirectResponse(url="/login", status_code=303)

@app.get("/login", response_class=HTMLResponse)
def get_login(request: Request, error: Optional[str] = None):
    """Renders the high-end Login gateway."""
    if is_authenticated(request):
        return RedirectResponse(url="/dashboard", status_code=303)
    return templates.TemplateResponse("login.html", {"request": request, "error": error})

@app.post("/login")
def post_login(response: Response, username: str = Form(...), password: str = Form(...)):
    """Handles admin authentication."""
    # No password configured means no way in - refuse rather than fall back to
    # a default, which would be a published credential in this public repo.
    if not ADMIN_PASSWORD:
        return RedirectResponse(url="/login?error=Server+is+not+configured+for+login.", status_code=303)

    # compare_digest on both fields to avoid leaking either via timing.
    valid = (secrets.compare_digest(username, ADMIN_USERNAME)
             & secrets.compare_digest(password, ADMIN_PASSWORD))
    if valid:
        response = RedirectResponse(url="/dashboard", status_code=303)
        response.set_cookie(
            key=COOKIE_NAME,
            value=_signer.dumps({"u": ADMIN_USERNAME}),
            httponly=True,
            samesite="lax",
            secure=COOKIE_SECURE,
            max_age=SESSION_MAX_AGE,
        )
        return response

    # Auth failed - reload with error
    return RedirectResponse(url="/login?error=Invalid+credentials.+Access+denied.", status_code=303)

@app.get("/logout")
def logout(response: Response):
    """Terminates session cookies and redirects."""
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(COOKIE_NAME)
    return response

@app.get("/dashboard", response_class=HTMLResponse)
def get_dashboard(request: Request):
    """Renders the main Marketplace Event timeline dashboard."""
    if not is_authenticated(request):
        return RedirectResponse(url="/login?error=Session+expired.+Please+log+in+again.", status_code=303)
    
    # Fetch events from SQLite
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM events ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()
    
    # Process rows to add pretty printed JSON payloads
    events = []
    total_count = len(rows)
    creation_count = 0
    active_count = 0
    cancelled_count = 0
    
    for row in rows:
        event_dict = dict(row)
        try:
            parsed_json = json.loads(event_dict["payload"])
            event_dict["payload_json"] = json.dumps(parsed_json, indent=2)
        except Exception:
            event_dict["payload_json"] = event_dict["payload"]
            
        events.append(event_dict)
        
        # Calculate stats. Deliberately strict: the tiles are labelled
        # "Creation Requests" / "Active Subscriptions" / "Cancellations", so
        # ACCOUNT_ACTIVE and suspensions are not folded in. They still appear in
        # the timeline and in total_count.
        e_type = event_dict["event_type"]
        if e_type == "ENTITLEMENT_CREATION_REQUESTED":
            creation_count += 1
        elif e_type == "ENTITLEMENT_ACTIVE":
            active_count += 1
        elif e_type == "ENTITLEMENT_CANCELLED":
            cancelled_count += 1

    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "events": events,
        "total_count": total_count,
        "creation_count": creation_count,
        "active_count": active_count,
        "cancelled_count": cancelled_count
    })

@app.get("/api/health/slack")
def get_health_slack(request: Request):
    """Posts a test message so the Slack webhook can be verified on a deployed instance."""
    if not is_authenticated(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    slack.notify(
        event_type="HEALTH_CHECK",
        entitlement_id="n/a",
        account_id="n/a",
        payload={"entitlement": {"product": "health-check"}},
    )
    return {"sent": True, "configured": bool(slack.WEBHOOK_URL)}

@app.get("/api/events/count")
def get_events_count(request: Request):
    """Lightweight endpoint for background polling of total logged events."""
    if not is_authenticated(request):
        return {"error": "Unauthorized"}, 401
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM events")
        count = cursor.fetchone()[0]
        conn.close()
        return {"count": count}
    except Exception as e:
        return {"error": str(e)}, 500

@app.post("/api/events/scrub")
def post_events_scrub(request: Request):
    """Securely deletes all logged events from the database table."""
    if not is_authenticated(request):
        return {"error": "Unauthorized"}, 401
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM events")
        conn.commit()
        conn.close()
        print("🧹 DATABASE SCRUBBED: All event logs have been securely wiped.")
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}, 500


