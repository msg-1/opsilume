"""OPSILUME MCP server.

Exposes the investigation tools (read-only) to any MCP client — Claude Desktop, Claude Code,
IDE assistants — over stdio. It talks to the OPSILUME API with an API key that has the
`tools:read` scope, so it sees exactly one organisation and can change nothing.

    OPSILUME_API_URL=http://localhost:4000 OPSILUME_API_KEY=opk_... uv run python -m app.mcp_server
"""

from __future__ import annotations

import inspect
import sys
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from .config import get_settings
from .tools import TOOLS, ToolClient, ToolError, ToolSpec, to_json

INSTRUCTIONS = (
    "Read-only access to OPSILUME: services and their dependencies, incidents, logs, deployments, code changes, "
    "service events, metrics and the engineering knowledge base. Start with list_services or get_incident_context. "
    "Time arguments accept ISO-8601 timestamps or relative values such as 30m, 6h, 2d."
)


def _handler(spec: ToolSpec, client_factory: Any):
    """Builds a function whose signature mirrors the tool's argument model, so the MCP schema is flat."""

    async def handler(**kwargs: Any) -> str:
        client: ToolClient = client_factory()
        try:
            return to_json(await client.call(spec.name, {k: v for k, v in kwargs.items() if v is not None}), limit=20_000)
        except ToolError as exc:
            return f"Error: {exc}"
        finally:
            await client.aclose()

    params = []
    annotations: dict[str, Any] = {"return": str}
    for name, f in spec.args.model_fields.items():
        default = inspect.Parameter.empty if f.is_required() else f.get_default(call_default_factory=True)
        params.append(inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, default=default, annotation=f.rebuild_annotation()))
        annotations[name] = f.rebuild_annotation()
    handler.__signature__ = inspect.Signature(params, return_annotation=str)  # type: ignore[attr-defined]
    handler.__annotations__ = annotations
    handler.__name__ = spec.name
    handler.__doc__ = spec.description
    return handler


def build_server(client_factory: Any | None = None) -> MCPServer:
    settings = get_settings()

    def default_factory() -> ToolClient:
        return ToolClient(settings.opsilume_api_url or settings.api_url, settings.opsilume_api_key, api_key=True)

    server = MCPServer("opsilume", instructions=INSTRUCTIONS)
    for spec in TOOLS:
        server.add_tool(
            _handler(spec, client_factory or default_factory), name=spec.name, description=spec.description,
            annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False),
            structured_output=False,
        )
    return server


def main() -> None:
    if not get_settings().opsilume_api_key:
        print("OPSILUME_API_KEY is not set. Create an API key with the tools:read scope in OPSILUME → Settings → API keys.", file=sys.stderr)
        raise SystemExit(2)
    build_server().run("stdio")


if __name__ == "__main__":
    main()
