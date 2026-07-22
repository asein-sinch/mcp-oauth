#!/bin/bash
set -e

PROJECT_ID="sinch-build"
REGION="us-central1"
IMAGE_TAG="gcr.io/$PROJECT_ID/sinch-messaging-agent:latest"
SERVICE_NAME="sinch-messaging-agent"

# Professional output colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== 🚀 Starting Sinch Messaging Agent Cloud Run Deployer ===${NC}"

# 1. Ensure required APIs are enabled
echo -e "${BLUE}[1/4] Checking and enabling required APIs (run.googleapis.com, cloudbuild.googleapis.com)...${NC}"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com --project="$PROJECT_ID"

# 2. Build the container image via Cloud Build
echo -e "${BLUE}[2/4] Building container image using Google Cloud Build...${NC}"
gcloud builds submit --tag "$IMAGE_TAG" --project="$PROJECT_ID"

# 3. Deploy the container to Cloud Run
echo -e "${BLUE}[3/4] Deploying container to Google Cloud Run...${NC}"
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_TAG" \
  --platform managed \
  --region "$REGION" \
  --allow-unauthenticated \
  --project="$PROJECT_ID" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION,SINCH_AUTH_SERVER_URL=https://asein-sinch-oauth-server.sliplane.app,SINCH_DEVICE_CLIENT_ID=sinch-agent,MCP_SERVER_URL=https://asein-sinch-mcp-jwt.sliplane.app/mcp"

# 4. Fetch the deployed service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --platform managed --region "$REGION" --project="$PROJECT_ID" --format='value(status.url)')

echo -e "${GREEN}=== ✅ Deployment Complete! ===${NC}"
echo -e "${GREEN}Your public Cloud Run URL is: ${SERVICE_URL}${NC}"
echo ""
echo -e "Use this URL to update the registered agent card inside Gemini Enterprise's Discovery Engine portal or via the PATCH curl command in the implementation plan."
