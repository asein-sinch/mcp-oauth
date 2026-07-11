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
5. In Sliplane's persistent volumes, map `/app/marketplace.db` to keep event logs persistent across deploys.
