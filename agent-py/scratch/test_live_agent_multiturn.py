import asyncio
import os
import sys

# Load env variables from sinch_messaging_agent/.env
from dotenv import load_dotenv
dotenv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sinch_messaging_agent", ".env"))
load_dotenv(dotenv_path)

# Ensure the root folder is in python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.artifacts.in_memory_artifact_service import InMemoryArtifactService
from google.adk.memory.in_memory_memory_service import InMemoryMemoryService
from google.genai import types as genai_types

from sinch_messaging_agent.agent import root_agent

async def main():
    print("Initializing Runner for Multi-Turn Integration Test...")
    session_service = InMemorySessionService()
    runner = Runner(
        app_name="sinch_messaging_agent",
        agent=root_agent,
        session_service=session_service,
        artifact_service=InMemoryArtifactService(),
        memory_service=InMemoryMemoryService(),
        auto_create_session=True,
    )

    queries = [
        "I want to onboard a new RCS sender",
        "Sinch Support",
        "A brand description for Sinch support notifications",
        "US, FR",
        "No"
    ]

    session_id = "multiturn_session"
    user_id = "test_user"

    for idx, query in enumerate(queries):
        print(f"\n--- Turn {idx + 1} ---")
        print(f"User: {query}")
        
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=genai_types.Content(
                role="user", 
                parts=[genai_types.Part.from_text(text=query)]
            ),
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text:
                        print("Agent:", part.text)
            if event.get_function_calls():
                for fc in event.get_function_calls():
                    print(f"Tool Call: {fc.name} with args: {fc.args}")
                    
    # Close resources
    for tool_union in root_agent.tools:
        if hasattr(tool_union, "close"):
            await tool_union.close()

if __name__ == "__main__":
    asyncio.run(main())
