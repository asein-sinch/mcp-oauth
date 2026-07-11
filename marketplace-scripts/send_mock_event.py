#!/usr/bin/env python3
"""
Sinch Marketplace Mock Event Publisher
This script publishes simulated Google Cloud Marketplace entitlement events
(such as ENTITLEMENT_CREATION_REQUESTED and ENTITLEMENT_ACTIVE) to your local
mock Pub/Sub topic so you can test your subscriber code.
"""

import json
import argparse
from google.cloud import pubsub_v1

PROJECT_ID = "sinch-build"
TOPIC_ID = "marketplace-mock-events"

def publish_mock_event(event_type, entitlement_id, account_id):
    publisher = pubsub_v1.PublisherClient()
    topic_path = publisher.topic_path(PROJECT_ID, TOPIC_ID)

    # Construct standard Google Cloud Marketplace event payload
    event_payload = {
        "eventId": f"mock-event-{entitlement_id}",
        "eventType": event_type,
        "entitlement": {
            "id": entitlement_id,
            "product": "sinchagent.endpoints.sinch-build.cloud.goog",
            "plan": "flat_fee_plan",
            "state": "ENTITLEMENT_ACTIVATION_REQUESTED" if event_type == "ENTITLEMENT_CREATION_REQUESTED" else "ENTITLEMENT_ACTIVE"
        },
        "account": {
            "id": account_id
        }
    }

    data = json.dumps(event_payload).encode("utf-8")
    future = publisher.publish(topic_path, data)
    print(f"✉️ Published {event_type} to local topic...")
    print(f"  - Message ID: {future.result()}")
    print(f"  - Payload: {json.dumps(event_payload, indent=2)}")

def main():
    parser = argparse.ArgumentParser(description="Publish Mock Marketplace Events")
    parser.add_argument("--type", default="ENTITLEMENT_CREATION_REQUESTED", 
                        choices=["ENTITLEMENT_CREATION_REQUESTED", "ENTITLEMENT_ACTIVE", "ENTITLEMENT_CANCELLED"],
                        help="The type of event to simulate")
    parser.add_argument("--entitlement", default="ent-12345", help="Mock Entitlement ID")
    parser.add_argument("--account", default="acc-99999", help="Mock Customer Account ID")
    args = parser.parse_args()

    publish_mock_event(args.type, args.entitlement, args.account)

if __name__ == "__main__":
    main()
