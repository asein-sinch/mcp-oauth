import asyncio
import os
import sys

# Load env variables from sinch_messaging_agent_a2ui/.env
from dotenv import load_dotenv
dotenv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "sinch_messaging_agent_a2ui", ".env"))
load_dotenv(dotenv_path)

# Ensure the root folder is in python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from a2a import types as a2a_types
from a2a.server import agent_execution, events
from sinch_messaging_agent_a2ui.agent_executor import AdkAgentToA2AExecutor

class MockRequestContext(agent_execution.RequestContext):
    def __init__(self, query_text):
        # We construct a mock Task object
        task_obj = a2a_types.Task(
            id="test_task_123",
            context_id="test_context_123",
            status={"state": "submitted"},
        )
        super().__init__(
            task_id="test_task_123",
            context_id="test_context_123",
            task=task_obj
        )
        self._query = query_text
        self._message = a2a_types.Message(
            message_id="msg_123",
            task_id="test_task_123",
            context_id="test_context_123",
            role="user",
            parts=[a2a_types.Part(root=a2a_types.TextPart(text=query_text))]
        )

    def get_user_input(self, delimiter: str = "\n") -> str:
        return self._query

    @property
    def message(self) -> a2a_types.Message | None:
        return self._message

async def main():
    print("Initializing A2UI Executor...")
    executor = AdkAgentToA2AExecutor()
    
    ctx = MockRequestContext("I want to onboard a new RCS sender")
    queue = events.EventQueue()
    
    print("Executing query turn 1...")
    
    # Run in background to consume the queue events
    async def consume_queue():
        while True:
            event = await queue.dequeue_event()
            if event:
                if isinstance(event, a2a_types.TaskStatusUpdateEvent):
                    print(f"\n[QUEUE EVENT] Status Update: state={event.status.state}")
                    if event.status.state in ("completed", "failed"):
                        break
                elif isinstance(event, a2a_types.TaskArtifactUpdateEvent):
                    print(f"\n[QUEUE EVENT] Artifact Update: name={event.artifact.name}")
                    for part in event.artifact.parts:
                        root = part.root
                        if isinstance(root, a2a_types.TextPart):
                            print(f"  TextPart: {root.text}")
                        elif isinstance(root, a2a_types.DataPart):
                            mime = root.metadata.get("mimeType") if root.metadata else None
                            print(f"  DataPart mimeType={mime}:")
                            print(f"    {json.dumps(root.data, indent=4)[:400]}...")
            await asyncio.sleep(0.1)

    import json
    # Run both concurrently
    await asyncio.gather(
        executor.execute(ctx, queue),
        consume_queue()
    )

if __name__ == "__main__":
    asyncio.run(main())
