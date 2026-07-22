import os
import vertexai
from vertexai.preview.reasoning_engines import A2aAgent
from google.genai import types
from google.protobuf import json_format
from a2a.types import AgentSkill
from vertexai.preview.reasoning_engines.templates.a2a import create_agent_card
from sinch_messaging_agent_a2ui.agent_executor import CloudRunProxyAgent
import json

# Monkey-patch json_format.MessageToJson and MessageToDict to handle Pydantic models (like AgentCard) correctly
original_message_to_json = json_format.MessageToJson
def patched_message_to_json(message, *args, **kwargs):
    if hasattr(message, "model_dump_json"):
        return message.model_dump_json()
    elif hasattr(message, "json"):
        return message.json()
    elif isinstance(message, dict):
        return json.dumps(message)
    return original_message_to_json(message, *args, **kwargs)
json_format.MessageToJson = patched_message_to_json

original_message_to_dict = json_format.MessageToDict
def patched_message_to_dict(message, *args, **kwargs):
    if hasattr(message, "model_dump"):
        return message.model_dump()
    elif hasattr(message, "dict"):
        return message.dict()
    elif isinstance(message, dict):
        return message
    return original_message_to_dict(message, *args, **kwargs)
json_format.MessageToDict = patched_message_to_dict

def main():
    project_id = "sinch-build"
    location = "us-central1"
    bucket = "gs://reasoning-engine-artifacts-for-sinch-agent"
    
    vertexai.init(project=project_id, location=location, staging_bucket=bucket)
    client = vertexai.Client(project=project_id, location=location)
    
    # Define agent skills
    skills = [
        AgentSkill(
            id="rcs_onboarding",
            name="RCS Onboarding",
            description="Guide user interactively step-by-step to configure and onboard a new RCS sender.",
            tags=["rcs", "onboarding"],
            examples=["I want to onboard a new RCS sender", "onboard rcs"],
        ),
        AgentSkill(
            id="campaign_manager",
            name="Campaign Manager",
            description="Generate interactive RCS preview campaigns and send them.",
            tags=["campaign", "send"],
            examples=["send a campaign", "create campaign"],
        ),
        AgentSkill(
            id="insights_manager",
            name="Insights Manager",
            description="Query messaging logs, track user engagement and present insights/reports.",
            tags=["insights", "metrics"],
            examples=["show message insights", "analytics"],
        )
    ]
    
    # Create the Agent Card
    my_card = create_agent_card(
        agent_name="Sinch Messaging Agent",
        description="An enterprise assistant that generates interactive UIs to onboard senders, send campaigns, and track analytics.",
        skills=skills,
    )
    
    # Instantiate the A2aAgent using the custom executor builder
    a2a_agent = A2aAgent(
        agent_card=my_card,
        agent_executor_builder=CloudRunProxyAgent,
    )
    
    # Existing Reasoning Engine ID — update in-place, no new ID created
    REASONING_ENGINE_ID = "7311979373861535744"
    existing_resource_name = f"projects/{project_id}/locations/{location}/reasoningEngines/{REASONING_ENGINE_ID}"

    # Deploy config with requirements and extra packages
    config = {
        "staging_bucket": bucket,
        "requirements": [
            "google-adk==2.2.0",
            "google-cloud-aiplatform[agent_engines,adk]==1.158.0",
            "a2a-sdk==0.3.26",
            "pydantic==2.13.4",
            "cloudpickle==3.1.2",
            "protobuf==6.33.6",
            "jsonschema==4.26.0",
            "referencing==0.37.0",
            "mcp==1.27.2",
            "httpx==0.28.1",
        ],
        "env_vars": {
            "GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY": "true",
            "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "true",
            # ── Session persistence: required for VertexAiSessionService ──
            "SINCH_AGENT_ENGINE_ID": REASONING_ENGINE_ID,
            # ── MCP server (JWT-authenticated) ────────────────────────────
            "MCP_SERVER_URL": "https://asein-sinch-mcp-jwt.sliplane.app/mcp",
            # ── Sinch auth server (Device Authorization Grant) ────────────
            "SINCH_AUTH_SERVER_URL": "https://asein-sinch-oauth-server.sliplane.app",
            "SINCH_DEVICE_CLIENT_ID": "sinch-agent",
        },
        "extra_packages": [
            "sinch_messaging_agent_a2ui",
            ".venv/lib/python3.10/site-packages/a2ui",
        ]
    }
    
    print(f"Updating existing instance: {existing_resource_name}")
    remote_agent = client.agent_engines.update(
        name=existing_resource_name,
        agent=a2a_agent,
        config=config,
    )

    print(f"Deploy complete: {remote_agent.api_resource.name}")



if __name__ == "__main__":
    main()
