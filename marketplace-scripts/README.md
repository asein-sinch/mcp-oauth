# Sinch Marketplace Operations & Deployment Scripts

This folder contains the operational tooling and documentation required to test, manage, and transition your Google Cloud Marketplace integration from a local draft/mock phase to a live production deployment.

---

## 📂 File Manifest

* **`marketplace_listener.py`**: Standard Python background subscriber listener. Perfect for running lightweight daemon integrations or reference checking.
* **`send_mock_event.py`**: Event simulator to publish test transaction JSON payloads directly to your local `marketplace-mock-events` topic.
* **`scrub_db.py`**: Secure database cleaning script to wipe test transactions from the persistent SQLite database before launching to staging or production.

---

## 🧹 How to Scrub Test Events Before Production

Before you point your dashboard to the live Google Marketplace topic, you will want to wipe any local mock events so your audit logs are clean and unpolluted.

Run the secure scrubbing tool:
```bash
python3 scrub_db.py --db ../marketplace-dashboard/marketplace.db
```
*(Confirm with `y` when prompted, and it will safely truncate all event logs while preserving your empty database table schema!).*

---

## 🔄 Re-routing to Live Production Events (Once approved)

Once the Google Cloud Marketplace **Pricing review** completes, the draft block in your Producer Portal will lift, and you can submit the technical integration form. After Google processes the submission, follow these quick steps to switch from mock events to live events:

### Step 1: Delete the Mock Subscription
Remove your current subscription (which is connected to the local mock topic):
```bash
gcloud pubsub subscriptions delete marketplace-events --project=sinch-build
```

### Step 2: Recreate Subscription Pointing to Google's Live Topic
Using the authorized service account key `sa-key.json` that is registered in your portal, recreate the subscription pointing directly to Google's central marketplace stream:

```bash
# 1. Log in as the authorized service account
gcloud auth activate-service-account --key-file=../sa-key.json

# 2. Create the production-bound subscription
gcloud pubsub subscriptions create marketplace-events \
  --topic=projects/cloudcommerceproc-prod/topics/sinch-build \
  --project=sinch-build

# 3. Restore your personal gcloud session
gcloud config set account antoine.sein@mailgun.com
```

### Step 3: Start Listening to Real Purchases!
Restart your Dashboard container or background Python listener. From this moment on, your microservice **will only receive live, secure, unpolluted purchase events** directly from real clients!
