"""Spawn the Specter MCP server and call its tools over the real stdio
transport. Confirms the server speaks proper MCP, not just Python."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


ROOT = Path(__file__).resolve().parent.parent


async def main() -> None:
    params = StdioServerParameters(
        command=str(ROOT / ".venv/bin/python"),
        args=[str(ROOT / "specter-mcp/server.py")],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])

            health = await session.call_tool("health", {})
            print("health:", health.content[0].text)

            for vendor in ["Acme Holdings Ltd", "Stripe", "Random Inc"]:
                resp = await session.call_tool("lookup_vendor", {"vendor": vendor})
                print(f"\nlookup {vendor}:\n  {resp.content[0].text}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"smoke failed: {exc}", file=sys.stderr)
        sys.exit(1)
