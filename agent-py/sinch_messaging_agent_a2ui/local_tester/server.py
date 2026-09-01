import os
os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "true"
import sys
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import json
import logging
from dotenv import load_dotenv

# Add workspace root directory to path to import the package
workspace_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(workspace_dir)

# Load environment variables from .env file in parent directory
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(parent_dir, '.env'))

from a2a import types as a2a_types
from a2a.server import events
from sinch_messaging_agent_a2ui.agent_executor import AdkAgentToA2AExecutor
from sinch_messaging_agent_a2ui.context_dump import dump_http_request

app = FastAPI()

# Enable CORS for local testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# Initialize our Custom Executor
executor = AdkAgentToA2AExecutor()

class MockServerCallContext:
    def __init__(self):
        self.activated_extensions = set()
        self.requested_extensions = set()

class LocalRequestContext:
    def __init__(self, message, task_id="test_task", context_id="test_context", sinch_id_token=None):
        self.message = message
        self.task_id = task_id
        self.context_id = context_id
        self.current_task = a2a_types.Task(
            id=task_id,
            context_id=context_id,
            status={"state": "submitted"}
        )
        self.call_context = MockServerCallContext()
        self.metadata = {}
        self.sinch_id_token = sinch_id_token

    def get_user_input(self, delimiter: str = "\n") -> str:
        text_parts = []
        for part in self.message.parts:
            if isinstance(part.root, a2a_types.TextPart):
                text_parts.append(part.root.text)
        return delimiter.join(text_parts)

@app.get("/.well-known/agent-card.json")
async def get_agent_card():
    return {
        "capabilities": {
            "streaming": False,
            "extensions": [{"uri": "https://a2ui.org/a2a-extension/a2ui/v0.8", "required": False}]
        },
        "name": "sinch_messaging_agent",
        "url": "https://sinch-messaging-agent-227017598651.us-central1.run.app",
        "version": "1.0.0"
    }

@app.get("/")
async def get_index():
    return FileResponse(os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html"))

@app.post("/")
@app.post("/jsonrpc")
@app.post("/jsonrpc/v1/message:send")
@app.post("/v1/message:send")
async def handle_jsonrpc(request: Request):
    body = await request.json()
    dump_http_request(request, body)
    logger.info(f"Received JSON-RPC request: {body}")
    
    if body.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid Request"}, "id": body.get("id")}
        
    method = body.get("method")
    params = body.get("params", {})
    request_id = body.get("id")
    
    if method == "message/send":
        message_data = params.get("message", {})
        query = message_data.get("text", "")
        parts_data = message_data.get("parts", [])
        session_id = params.get("session_id", "local_session")
        
        # Build A2A Message object from request parts
        message_parts = []
        for part_data in parts_data:
            if "text" in part_data:
                message_parts.append(a2a_types.Part(root=a2a_types.TextPart(text=part_data["text"])))
            elif "data" in part_data:
                message_parts.append(a2a_types.Part(root=a2a_types.DataPart(
                    data=part_data["data"],
                    metadata=part_data.get("metadata", {})
                )))
        
        # If no explicit parts were sent but query is present, add a TextPart
        if not message_parts and query:
            message_parts.append(a2a_types.Part(root=a2a_types.TextPart(text=query)))

        msg_obj = a2a_types.Message(
            message_id="msg_" + str(request_id or "default"),
            task_id="task_" + session_id,
            context_id=session_id,
            role="user",
            parts=message_parts
        )
        
        # Resolve the Sinch OIDC user token:
        auth_header = request.headers.get("Authorization")
        sinch_id_token = None

        # 1. Attempt JSON-RPC body params extraction (oauth2 configuration)
        if isinstance(params, dict):
            authorization = params.get("authorization", {})
            if isinstance(authorization, dict):
                oauth2 = authorization.get("oauth2", {})
                if isinstance(oauth2, dict):
                    sinch_id_token = oauth2.get("idToken") or oauth2.get("accessToken")

        # 2. Fall back to incoming HTTP Authorization header
        if not sinch_id_token and auth_header and auth_header.startswith("Bearer "):
            sinch_id_token = auth_header.split(" ")[1]

        if sinch_id_token:
            logger.info(f"[SECURITY] Sinch ID Token resolved (length: {len(sinch_id_token)})")

        ctx = LocalRequestContext(msg_obj, task_id="task_" + session_id, context_id=session_id, sinch_id_token=sinch_id_token)
        queue = events.EventQueue()
        
        # Execute the agent runner inside the A2A Executor
        await executor.execute(ctx, queue)
        
        # Consume the queue events to gather the final response parts
        response_parts = []
        while True:
            try:
                event = queue.queue.get_nowait()
                logger.info(f"[DEBUG QUEUE] Received event: type={type(event).__name__}, event={event}")
                if hasattr(event, "artifact") and getattr(event, "artifact", None) and hasattr(event.artifact, "parts"):
                    for part in getattr(event.artifact, "parts", []):
                        response_parts.append(part)
                elif hasattr(event, "parts") and getattr(event, "parts", None):
                    for part in getattr(event, "parts", []):
                        response_parts.append(part)
                queue.queue.task_done()
            except asyncio.QueueEmpty:
                break
                
        # Build strict, non-nested, camelCased A2A response
        msg_resp = a2a_types.Message(
            message_id=f"msg_resp_{request_id or 'default'}",
            role="agent",
            parts=response_parts,
            task_id="task_" + session_id,
            context_id=session_id
        )
        
        return {
            "jsonrpc": "2.0",
            "result": msg_resp.model_dump(mode="json", by_alias=True, exclude_none=True),
            "id": request_id
        }
        
    return {"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method not found"}, "id": request_id}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8002)
