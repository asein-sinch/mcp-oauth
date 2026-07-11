#!/usr/bin/env python3
"""
Sinch Marketplace Pub/Sub Listener
This script listens to Google Cloud Marketplace lifecycle notifications
(such as subscription signups, upgrades, and cancellations) and prints them out
with mock account provisioning hooks where you can plug in your backend API.
"""

import os
import json
import argparse
from google.cloud import pubsub_v1

# Setup default configurations
PROJECT_ID = "sinch-build"
SUBSCRIPTION_ID = "marketplace-events"

def process_marketplace_event(message):
    """
    Parses and handles the Google Cloud Marketplace event payload.
    """
    try:
        # Decodes the message data
        data_str = message.data.decode("utf-8")
        event = json.loads(data_str)
        
        event_type = event.get("eventType")
        entitlement_id = event.get("entitlement", {}).get("id")
        account_id = event.get("account", {}).get("id")
        
        print(f"\n[RECEIVED EVENT] Type: {event_type}")
        print(f"  - Entitlement ID: {entitlement_id}")
        print(f"  - Account ID: {account_id}")
        print(f"  - Full Payload: {json.dumps(event, indent=2)}")

        # Implement Provisioning Flow Hooks
        if event_type == "ENTITLEMENT_CREATION_REQUESTED":
            print(f"👉 ACTION REQUIRED: Customer requested a subscription purchase. Call approve API for Entitlement: {entitlement_id}")
            # TODO: Call partner procurement API to approve:
            # POST https://cloudcommerceprocurement.googleapis.com/v1/providers/.../entitlements/{entitlement_id}:approve
            
        elif event_type == "ENTITLEMENT_ACTIVE":
            print(f"🎉 SUCCESS: Entitlement {entitlement_id} is active! Provisioning workspace for Account: {account_id}...")
            # TODO: Connect to your database, create user records, enable premium CPaaS APIs.
            
        elif event_type == "ENTITLEMENT_CANCELLED":
            print(f"⚠️ NOTICE: Entitlement {entitlement_id} has been cancelled. Deprovisioning workspace for Account: {account_id}...")
            # TODO: Suspend user records, disable premium CPaaS APIs.

        # Acknowledge that the message has been successfully handled
        message.ack()
        print("[ACKNOWLEDGED] Message processed successfully.")

    except Exception as e:
        print(f"❌ Error processing message: {e}")
        # Nack the message so it gets redelivered for retry
        message.nack()

def main():
    parser = argparse.ArgumentParser(description="Google Cloud Marketplace Pub/Sub Listener")
    parser.add_argument("--project", default=PROJECT_ID, help="GCP Project ID")
    parser.add_argument("--sub", default=SUBSCRIPTION_ID, help="Pub/Sub Subscription ID")
    args = parser.parse_args()

    # Determine credentials path (if running locally, authenticate via service account JSON key)
    # e.g., export GOOGLE_APPLICATION_CREDENTIALS="path/to/key.json"
    subscriber = pubsub_v1.SubscriberClient()
    subscription_path = subscriber.subscription_path(args.project, args.sub)

    print(f"🛰️ Listening for Google Cloud Marketplace events on subscription: {subscription_path}...")
    print("Press Ctrl+C to exit.")

    # Start pulling messages asynchronously
    streaming_pull_future = subscriber.subscribe(subscription_path, callback=process_marketplace_event)
    
    with subscriber:
        try:
            # Block and run indefinitely
            streaming_pull_future.result()
        except KeyboardInterrupt:
            streaming_pull_future.cancel()
            print("\nShutting down listener gracefully.")
        except Exception as e:
            print(f"Fatal Subscriber Error: {e}")

if __name__ == "__main__":
    main()
