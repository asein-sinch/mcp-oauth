import os
import json
import sqlite3
import threading
import time
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Form, Request, Depends, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from google.cloud import pubsub_v1
from google.api_core.exceptions import GoogleAPIError

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

# Configure environment variables (with secure defaults for PoC)
DB_PATH = os.getenv("DB_PATH", "marketplace.db")
PROJECT_ID = os.getenv("PROJECT_ID", "sinch-build")
SUBSCRIPTION_ID = os.getenv("SUBSCRIPTION_ID", "marketplace-events")

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "sinch-market-2026")
COOKIE_NAME = "sinch_session"
COOKIE_VALUE = "authenticated_admin_session_token"

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
    """Checks if the user has a valid admin session cookie."""
    return request.cookies.get(COOKIE_NAME) == COOKIE_VALUE

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
                try:
                    data_str = message.data.decode("utf-8")
                    event = json.loads(data_str)
                    
                    event_id = event.get("eventId", f"msg-{message.message_id}")
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
                        payload=data_str
                    )
                    
                    # Acknowledge Pub/Sub message
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
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        # Authentication successful - set cookie
        response = RedirectResponse(url="/dashboard", status_code=303)
        response.set_cookie(
            key=COOKIE_NAME,
            value=COOKIE_VALUE,
            httponly=True,
            samesite="lax",
            secure=False  # Set to True in production with SSL
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
        
        # Calculate stats
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
