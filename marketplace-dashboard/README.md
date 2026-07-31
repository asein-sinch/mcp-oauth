# Sinch Google Cloud Marketplace Event Dashboard Container

This is a premium, secure, and fully-containerized web dashboard designed to poll lifecycle purchase events from your Google Cloud Marketplace Pub/Sub stream, store them in a persistent SQLite database, and visualize them on an elegant, real-time glassmorphism timeline.

---

## 🚀 Quickstart: Running Locally

### 1. Set Up Environment & Install Dependencies
Navigate to the `marketplace-dashboard` directory and set up your python virtual environment:
```bash
cd marketplace-dashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure Credentials (Optional)
The subscriber worker will use your active local `gcloud` credentials by default. To use a specific service account key file:
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/sa-key.json"
```

Configure your login credentials and details:
```bash
export ADMIN_USERNAME="admin"
export ADMIN_PASSWORD="your-secure-password"
```

### 2b. Slack notifications & auto-approval
Copy `.env.example` to `.env` and fill it in — `main.py` loads it on startup, and `.env` is gitignored.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | unset | Slack Workflow Builder "From a webhook" trigger URL for `#ax-team`. Unset means notifications are skipped, not an error. |
| `AUTO_APPROVE` | `true` | Whether to answer Marketplace notifications by calling the Procurement API. **Set to `false` locally** so a stray run cannot approve a real entitlement. |
| `PROCUREMENT_PROVIDER_ID` | `sinch-build` | Producer id in the Procurement API path. Verified correct; override only if it changes. |

The Procurement calls use the same producer service account as the Pub/Sub subscriber
(`GOOGLE_CREDENTIALS_JSON`, or `GOOGLE_APPLICATION_CREDENTIALS`). A personal user account is not
authorized and will get HTTP 403.

Verify the pieces independently before deploying — see `tests/`:
```bash
python tests/test_slack_notify.py                      # Slack only
AUTO_APPROVE=true python tests/test_procurement.py     # Procurement auth; expect HTTP 404
AUTO_APPROVE=false python tests/test_process_event.py  # full path, no Pub/Sub
```

⚠️ Do not run this app locally against the real `SUBSCRIPTION_ID`. It is bound to the production
Marketplace topic, so a local subscriber competes with the deployed instance and real events go to
one or the other at random.

### 3. Run the Server
Launch the FastAPI development server:
```bash
uvicorn main:app --host 127.0.0.1 --port 8080 --reload
```

Open your browser and navigate to:
👉 **[http://127.0.0.1:8080](http://127.0.0.1:8080)**

---

## 🐳 Containerization & Deployment

To package this application as a container:

```bash
docker build -t marketplace-dashboard:latest .
```

### Run with Docker Locally:
```bash
docker run -d \
  -p 8080:8080 \
  -e ADMIN_USERNAME="admin" \
  -e ADMIN_PASSWORD="your-secure-password" \
  -e PROJECT_ID="sinch-build" \
  -e SUBSCRIPTION_ID="marketplace-events" \
  -v $(pwd)/marketplace.db:/app/marketplace.db \
  marketplace-dashboard:latest
```

---

## 🌐 Deploying to Sliplane
1. Push this `marketplace-dashboard/` folder to your workspace's Git repository.
2. In your **Sliplane** console, click **Create New Service** and select **Docker Container**.
3. Choose your repository and point the build path to the `marketplace-dashboard/` subdirectory.
4. Add the following environment variables in Sliplane:
   - `ADMIN_USERNAME`: `your-username`
   - `ADMIN_PASSWORD`: `your-secure-password`
   - `PROJECT_ID`: `sinch-build`
   - `SUBSCRIPTION_ID`: `marketplace-events`
   - `SLACK_WEBHOOK_URL`: the Workflow Builder trigger URL for `#ax-team`
   - `AUTO_APPROVE`: `true` (production is the side that must answer Google)
5. In Sliplane's persistent volumes, map `/app/marketplace.db` to keep event logs persistent across deploys.
6. After deploying, confirm the webhook works by logging in and visiting `/api/health/slack` — it posts a test message to `#ax-team`.
