import asyncio
from unittest.mock import patch
import pytest

from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.artifacts.in_memory_artifact_service import InMemoryArtifactService
from google.adk.memory.in_memory_memory_service import InMemoryMemoryService
from google.genai import types

from sinch_messaging_agent.agent import root_agent

@pytest.fixture(scope="function")
def runner():
    """Fixture to provide a clean Runner instance for each test."""
    return Runner(
        app_name="test_app",
        agent=root_agent,
        session_service=InMemorySessionService(),
        artifact_service=InMemoryArtifactService(),
        memory_service=InMemoryMemoryService(),
        auto_create_session=True,
    )

def test_agent_tool_calling(runner):
    """Test the agent tool calling flow with mocked Gemini responses."""
    async def run_test():
        # Turn 1: LLM decides to send a message
        turn_1_response = types.GenerateContentResponse(
            candidates=[
                types.Candidate(
                    finish_reason=types.FinishReason.STOP,
                    content=types.Content(
                        role="model",
                        parts=[
                            types.Part(
                                function_call=types.FunctionCall(
                                    id="fc-1",
                                    name="send-rcs-message",
                                    args={
                                        "to": "+33612345678",
                                        "message": {"text_message": {"text": "Hello, this is a test campaign"}},
                                        "appId": "default_app"
                                    }
                                )
                            )
                        ]
                    )
                )
            ]
        )
        
        # Turn 2: LLM summarizes the output once the delivery is confirmed
        turn_2_response = types.GenerateContentResponse(
            candidates=[
                types.Candidate(
                    finish_reason=types.FinishReason.STOP,
                    content=types.Content(
                        role="model",
                        parts=[
                            types.Part(
                                text="RCS message sent successfully! Message ID: msg_123"
                            )
                        ]
                    )
                )
            ]
        )

        from google.adk.models.llm_response import LlmResponse
        responses = [
            LlmResponse.create(turn_1_response),
            LlmResponse.create(turn_2_response)
        ]
        call_count = 0

        async def mock_generate_content_async(self, llm_request, stream=False):
            nonlocal call_count
            resp = responses[call_count]
            call_count += 1
            yield resp

        from google.adk.models.google_llm import Gemini
        # Patch Gemini model to respond with our mock frames
        with patch.object(Gemini, "generate_content_async", mock_generate_content_async):
            events = []
            try:
                async for event in runner.run_async(
                    user_id="test_user",
                    session_id="test_session",
                    new_message=types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text="Send campaign message to +33612345678")
                        ]
                    )
                ):
                    events.append(event)
            finally:
                # Ensure MCP connection closes and child processes are cleaned up
                for tool_union in root_agent.tools:
                    if hasattr(tool_union, "close"):
                        await tool_union.close()

            # Verify model's final response text
            final_messages = [
                part.text
                for e in events
                if e.content and e.content.role == "model" and e.content.parts
                for part in e.content.parts
                if part.text
            ]
            assert any("RCS message sent successfully" in msg for msg in final_messages)

            # Verify that the agent correctly called the 'send-rcs-message' tool
            tool_calls = []
            for e in events:
                if e.get_function_calls():
                    tool_calls.extend(e.get_function_calls())
            
            assert any(tc.name == "send-rcs-message" for tc in tool_calls)

    asyncio.run(run_test())
