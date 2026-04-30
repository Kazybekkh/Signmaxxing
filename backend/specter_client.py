"""Backend-side Specter MCP client.

Spawns the local Specter MCP server (or any MCP server speaking stdio) once
per process and keeps the session alive for cheap tool calls. Caches
responses for 5 minutes since MCP can be slow.

Set `SPECTER_MCP_COMMAND` and `SPECTER_MCP_ARGS` (JSON list) to point at a
different MCP server (e.g. Francisco's). Without those it spawns the local
one in `specter-mcp/server.py`."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PYTHON = str(ROOT / ".venv" / "bin" / "python")
DEFAULT_SERVER = str(ROOT / "specter-mcp" / "server.py")

CACHE_TTL_S = 300


class SpecterClient:
    def __init__(self) -> None:
        self._session: Optional[ClientSession] = None
        self._stack: Optional[AsyncExitStack] = None
        self._lock = asyncio.Lock()
        self._cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def _server_params(self) -> StdioServerParameters:
        cmd = os.environ.get("SPECTER_MCP_COMMAND", DEFAULT_PYTHON)
        args_json = os.environ.get("SPECTER_MCP_ARGS")
        if args_json:
            try:
                args = json.loads(args_json)
            except json.JSONDecodeError:
                args = [DEFAULT_SERVER]
        else:
            args = [DEFAULT_SERVER]
        return StdioServerParameters(command=cmd, args=args, env=os.environ.copy())

    async def _ensure_session(self) -> ClientSession:
        if self._session is not None:
            return self._session
        async with self._lock:
            if self._session is not None:
                return self._session
            stack = AsyncExitStack()
            try:
                read, write = await stack.enter_async_context(
                    stdio_client(self._server_params())
                )
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                self._stack = stack
                self._session = session
                print(
                    "[specter-client] MCP session initialised",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:
                await stack.aclose()
                raise
        return self._session

    async def lookup(self, vendor: str) -> dict[str, Any]:
        now = time.time()
        cached = self._cache.get(vendor)
        if cached and now - cached[0] < CACHE_TTL_S:
            return cached[1]

        try:
            session = await self._ensure_session()
            resp = await session.call_tool("lookup_vendor", {"vendor": vendor})
            text = resp.content[0].text if resp.content else "{}"
            data = json.loads(text)
        except Exception as exc:
            print(
                f"[specter-client] MCP call failed for {vendor}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            self._session = None
            if self._stack is not None:
                await self._stack.aclose()
                self._stack = None
            raise

        self._cache[vendor] = (now, data)
        return data

    async def aclose(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
            self._stack = None
            self._session = None


client = SpecterClient()
