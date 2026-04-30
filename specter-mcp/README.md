# Specter MCP

Local Model Context Protocol server that exposes vendor enrichment for the
Signmaxxing demo. Wraps the same fixtures the backend serves so the agent
sees identical data via real MCP tool calls instead of HTTP.

## Tools

| Tool | Description |
|---|---|
| `lookup_vendor(vendor: str)` | Returns JSON enrichment for one vendor (domain, incorporation date, employee count, risk flags). |
| `list_known_vendors()` | Returns the names with rich fixtures on file. |
| `health()` | Returns server status + whether upstream Specter is configured. |

## Run standalone (stdio)

```bash
../.venv/bin/python server.py
```

Stdio is the canonical MCP transport — Cursor SDK, Claude Desktop, and
the official `mcp` Inspector will all spawn it the same way.

## Wire into the Cursor SDK agent

The agent (`agent/run.ts`) already configures it via `mcpServers`:

```ts
mcpServers: {
  specter: {
    command: "/path/to/.venv/bin/python",
    args: ["/path/to/specter-mcp/server.py"],
    env: {},
  },
},
```

## Swap in Francisco's hosted Specter

Set `SPECTER_UPSTREAM_URL` (and `SPECTER_UPSTREAM_KEY` if needed) in the
environment before starting. `lookup_vendor` will proxy to
`{UPSTREAM_URL}/vendors/{vendor}` and only fall back to fixtures if the
upstream call fails. `source` flips from `"specter-local"` to `"specter"`
so the XR card UI updates automatically.
