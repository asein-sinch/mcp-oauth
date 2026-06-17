import os
from google.adk.agents.llm_agent import Agent
from google.adk.tools import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from mcp import StdioServerParameters

# Resolve absolute path to the workspace directory to give the MCP filesystem server access
workspace_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Initialize MCP filesystem toolset pointing to the official server via npx stdio connection
filesystem_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command="npx",
            args=["-y", "@modelcontextprotocol/server-filesystem", workspace_dir],
        ),
        timeout=15.0,
    )
)

root_agent = Agent(
    model="gemini-2.5-flash",
    name="root_agent",
    description="A filesystem assistant that manages workspace files using MCP tools.",
    instruction=(
        "You are an assistant with access to the local filesystem. Use the provided tools "
        "to search, read, write, or list files in the workspace as requested by the user."
    ),
    tools=[filesystem_toolset],
)
