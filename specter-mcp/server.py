"""Local Specter MCP server.

Speaks the real Model Context Protocol over stdio so Cursor SDK agents (and
any other MCP client) can call it. Wraps the same fixture data the backend
returns from `/specter/{vendor}` so demos are consistent.

When Francisco's hosted Specter MCP becomes available, set
`SPECTER_UPSTREAM_URL` and we'll proxy calls there instead of returning
fixtures. The tool surface stays identical.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("specter")

FIXTURES: dict[str, dict[str, Any]] = {
    "Acme Holdings Ltd": {
        "vendor": "Acme Holdings Ltd",
        "domain": "acme-holdings.co",
        "incorporation_date": "2026-04-25",
        "employee_count": 1,
        "risk_flags": [
            "Incorporated 5 days ago",
            "Director shares address with 12 other shell entities",
            "No filed accounts",
        ],
        "source": "specter-local",
    },
    "Nexus Global Trading": {
        "vendor": "Nexus Global Trading",
        "domain": None,
        "incorporation_date": "2024-11-02",
        "employee_count": 3,
        "risk_flags": [
            "No public website on file",
            "Free-zone registration in Dubai",
            "Sanctions-list adjacent counterparties",
        ],
        "source": "specter-local",
    },
    "QuickPay Solutions": {
        "vendor": "QuickPay Solutions",
        "domain": "quickpay-solutions.tk",
        "incorporation_date": "2025-09-12",
        "employee_count": 0,
        "risk_flags": [
            "Domain on .tk free TLD",
            "Seychelles incorporation, opaque ownership",
            "Bank account opened 11 days ago",
        ],
        "source": "specter-local",
    },
}

UPSTREAM_URL = os.environ.get("SPECTER_UPSTREAM_URL")
UPSTREAM_KEY = os.environ.get("SPECTER_UPSTREAM_KEY")


def _log(msg: str) -> None:
    # MCP stdio transport reserves stdout for protocol messages, so log to stderr.
    print(f"[specter-mcp] {msg}", file=sys.stderr, flush=True)


async def _fetch_upstream(vendor: str) -> dict[str, Any] | None:
    if not UPSTREAM_URL:
        return None
    headers = {"accept": "application/json"}
    if UPSTREAM_KEY:
        headers["authorization"] = f"Bearer {UPSTREAM_KEY}"
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.get(
                f"{UPSTREAM_URL.rstrip('/')}/vendors/{vendor}", headers=headers
            )
            if r.status_code == 200:
                data = r.json()
                data.setdefault("source", "specter")
                return data
            _log(f"upstream {vendor} -> HTTP {r.status_code}")
        except httpx.HTTPError as e:
            _log(f"upstream error for {vendor}: {e}")
    return None


@mcp.tool()
async def lookup_vendor(vendor: str) -> str:
    """Look up enrichment data for a vendor by exact name.

    Returns JSON with: vendor, domain, incorporation_date, employee_count,
    risk_flags (array of strings), source.

    Use this whenever you need to verify a vendor before approving a payment.
    """
    upstream = await _fetch_upstream(vendor)
    if upstream is not None:
        _log(f"upstream hit for {vendor}")
        return json.dumps(upstream)

    fixture = FIXTURES.get(vendor)
    if fixture is not None:
        return json.dumps(fixture)

    return json.dumps(
        {
            "vendor": vendor,
            "domain": None,
            "incorporation_date": None,
            "employee_count": None,
            "risk_flags": ["No Specter record found"],
            "source": "specter-local",
        }
    )


@mcp.tool()
def list_known_vendors() -> str:
    """Return the list of vendor names with rich Specter records on file.

    Useful for an agent to decide which invoices warrant a lookup."""
    return json.dumps(sorted(FIXTURES.keys()))


@mcp.tool()
def health() -> str:
    """Report MCP server health, upstream config, and fixture count."""
    return json.dumps(
        {
            "ok": True,
            "fixtures": len(FIXTURES),
            "upstream_configured": bool(UPSTREAM_URL),
        }
    )


if __name__ == "__main__":
    _log(
        f"starting Specter MCP (fixtures={len(FIXTURES)}, "
        f"upstream={'yes' if UPSTREAM_URL else 'no'})"
    )
    mcp.run()
