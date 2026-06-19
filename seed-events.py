#!/usr/bin/env python3
"""
Seed the sinch-events-server with manufactured Conversation API events for June 2026.

Distribution across June 1-15:
  ~60 messages  →  READ 58% / DELIVERED 25% / FAILED 12% / QUEUED 5%
  8 opt-in events, 3 opt-out events
"""

import json, random, subprocess, sys
from datetime import datetime, timezone, timedelta

# ── config ────────────────────────────────────────────────────────────────────
EVENTS_URL  = "https://matsk-sinch-sinch-events-server.sliplane.app/ConversationEvent"
APP_ID      = "01KTXDT6QK6JGNKDV1X0N0C4GD"
PROJECT_ID  = "37b62a7b-0177-429a-bb0b-e10f848de0b8"

RECIPIENTS = [
    "33611223300", "33622334401", "33633445502", "33644556603",
    "33655667704", "33666778805", "33677889906", "33688990007",
    "33699001108", "33600112209", "33611334410", "33622445511",
    "33633556612", "33644667713", "33655778814",
]

CAMPAIGNS = [
    "Flash Garden Sale: Seeds, Tools & Plants",
    "Summer Collection Launch",
    "Loyalty Program: Exclusive Rewards",
    "Member-Only Weekend Offer",
]

B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def gen_id(seed: int) -> str:
    rng = random.Random(seed)
    return "01KV" + "".join(rng.choices(B32, k=22))

def ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

def post(payload: dict) -> int:
    r = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "POST", EVENTS_URL,
         "-H", "Content-Type: application/json",
         "-d", json.dumps(payload)],
        capture_output=True, text=True
    )
    return int(r.stdout.strip() or "0")

def submit_event(msg_id: str, recipient: str, campaign: str, t: datetime) -> dict:
    return {
        "app_id": APP_ID, "project_id": PROJECT_ID,
        "accepted_time": ts(t), "event_time": ts(t),
        "message_metadata": "", "correlation_id": "",
        "message_submit_notification": {
            "message_id": msg_id, "conversation_id": "", "contact_id": "",
            "metadata": "", "processing_mode": "DISPATCH",
            "channel_identity": {"channel": "RCS", "identity": recipient, "app_id": ""},
            "submitted_message": {"text_message": {"text": campaign}},
        },
    }

def delivery_event(msg_id: str, recipient: str, status: str, t: datetime,
                   reason: dict | None = None) -> dict:
    report = {
        "message_id": msg_id, "conversation_id": "", "contact_id": "",
        "metadata": "", "processing_mode": "DISPATCH", "status": status,
        "channel_identity": {"channel": "RCS", "identity": recipient, "app_id": ""},
        "reason": reason,
    }
    return {
        "app_id": APP_ID, "project_id": PROJECT_ID,
        "accepted_time": ts(t), "event_time": ts(t),
        "message_metadata": "", "correlation_id": "",
        "channel_metadata": {"rcs": {"operator": "20820"}},
        "message_delivery_report": report,
    }

def opt_event(kind: str, recipient: str, t: datetime) -> dict:
    key  = "opt_in_notification" if kind == "OPT_IN" else "opt_out_notification"
    stat = "OPT_IN_SUCCEEDED"   if kind == "OPT_IN" else "OPT_OUT_SUCCEEDED"
    return {
        "app_id": APP_ID, "project_id": PROJECT_ID,
        "accepted_time": ts(t), "event_time": ts(t),
        key: {
            "contact_id": "", "request_id": gen_id(hash((kind, recipient, t.day))),
            "channel": "RCS", "identity": recipient,
            "status": stat, "processing_mode": "DISPATCH",
        },
    }

# ── build event list ──────────────────────────────────────────────────────────
rng   = random.Random(42)
events: list[dict] = []
seed  = 2000

for day in [d for d in range(1, 17) if d != 15]:  # skip today (real events already there)
    count = rng.randint(3, 5)
    for _ in range(count):
        t0 = datetime(2026, 6, day, rng.randint(8, 18), rng.randint(0, 59),
                      rng.randint(0, 59), tzinfo=timezone.utc)
        msg_id    = gen_id(seed); seed += 1
        recipient = rng.choice(RECIPIENTS)
        campaign  = rng.choice(CAMPAIGNS)

        r = rng.random()
        outcome = "READ" if r < 0.58 else "DELIVERED" if r < 0.83 else "FAILED" if r < 0.95 else "QUEUED"

        events.append(submit_event(msg_id, recipient, campaign, t0))
        events.append(delivery_event(msg_id, recipient, "QUEUED_ON_CHANNEL",
                                     t0 + timedelta(seconds=rng.randint(1, 3))))

        if outcome in ("DELIVERED", "READ"):
            events.append(delivery_event(msg_id, recipient, "DELIVERED",
                                         t0 + timedelta(seconds=rng.randint(4, 10))))
        if outcome == "READ":
            events.append(delivery_event(msg_id, recipient, "READ",
                                         t0 + timedelta(minutes=rng.randint(2, 120))))
        if outcome == "FAILED":
            events.append(delivery_event(msg_id, recipient, "FAILED",
                                         t0 + timedelta(seconds=rng.randint(5, 30)),
                                         reason={"code": "OUTSIDE_ALLOWED_SENDING_WINDOW",
                                                 "description": "Delivery failed",
                                                 "sub_code": "UNSPECIFIED_SUB_CODE"}))

# opt-in / opt-out
for i in range(8):
    day = rng.randint(1, 15)
    t   = datetime(2026, 6, day, rng.randint(9, 17), rng.randint(0, 59), tzinfo=timezone.utc)
    events.append(opt_event("OPT_IN",  rng.choice(RECIPIENTS), t))
for i in range(3):
    day = rng.randint(5, 15)
    t   = datetime(2026, 6, day, rng.randint(9, 17), rng.randint(0, 59), tzinfo=timezone.utc)
    events.append(opt_event("OPT_OUT", rng.choice(RECIPIENTS), t))

# ── insert ────────────────────────────────────────────────────────────────────
ok = ko = 0
for i, ev in enumerate(events):
    code = post(ev)
    if code in (200, 201, 204):
        ok += 1
    else:
        ko += 1
        print(f"  ✗ event {i} got HTTP {code}", file=sys.stderr)
    if (i + 1) % 20 == 0:
        print(f"  {i+1}/{len(events)} inserted...")

print(f"\nDone: {ok} inserted, {ko} failed (total {len(events)} events)")
