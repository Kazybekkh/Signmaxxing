# Signmaxxing

WebXR approval room for ambiguous invoices. Built for Cursor Hack London 2026,
Track 01 (Money Movement). Per the spec in [`CLAUDE.md`](./CLAUDE.md).

A Cursor SDK agent processes a batch of fake invoices, auto-pays the safe
ones, and floats the ambiguous ones into 3D space as cards. The user inspects
each card (with Specter MCP enrichment), then approves or rejects via
controller gesture. Approvals are signed Ed25519 in the browser and verified
server-side before "execution".

```
┌─────────────┐    POST /auto_pay         ┌────────────────┐
│  agent/     │ ───────────────────────►  │  backend/      │
│  (bun)      │    POST /escalations      │  FastAPI+SQLite│
└─────────────┘                           └────────┬───────┘
                                                   │
                       GET /escalations            │
                       POST /pubkey                │
                       POST /approve  ◄────────────┤
                                                   │
       ┌──────────────────────────────────┐        │
       │  xr/  (Vite + Three.js + WebXR)  │ ◄──────┘
       │  + tweetnacl Ed25519             │
       └──────────────────────────────────┘
```

## What's in here

| Path | Role |
|---|---|
| `backend/` | FastAPI app, raw `sqlite3`, all endpoints in `main.py`. Also serves the read-only HUD at `/`. |
| `backend/seed.py` | 50 invoices: 30 small + 10 medium + 7 large + 3 sketchy. After agent run: 47 auto-paid, 3 escalated. |
| `backend/heuristics.py` | Deterministic local scoring shared between the backend stub and the agent fallback. |
| `agent/` | Cursor SDK / TypeScript agent. `run.ts` uses `@cursor/sdk` (`Agent.create({ model: "composer-2", local, mcpServers })`) with the local Specter MCP attached so escalation reasoning is grounded in real MCP tool calls. Local heuristic in `score.ts` does the bulk scoring in <1s. |
| `specter-mcp/` | Local **Specter MCP server** (Python `FastMCP`, stdio transport). Exposes `lookup_vendor`, `list_known_vendors`, `health` over real MCP. Both the backend and the Cursor SDK agent talk to it; swap in Francisco's hosted Specter by setting `SPECTER_UPSTREAM_URL`. |
| `xr/` | Vite + raw Three.js. `main.ts` builds the scene, `card.ts` is the floating invoice mesh, `sign.ts` wraps tweetnacl, `specter.ts` does cached MCP lookups. |
| `shared/types.ts` | Single source of truth for `Invoice`, `Card`, `SignedApproval` etc. |
| `scripts/` | One-shot smoke scripts (`e2e.ts`, `sign_roundtrip.ts`). |

## Quickstart

Three terminals.

```bash
# 1. Backend (port 8000) — also serves the HUD at http://127.0.0.1:8000/
#    The backend spawns the Specter MCP server on demand via stdio.
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
(cd backend && ../.venv/bin/python seed.py)
(cd backend && ../.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload)

# 2. XR (port 5173) — open on the headset
(cd xr && bun install && bun run dev)

# 3. Agent — one-shot per demo run, runs through the Cursor SDK
echo 'CURSOR_API_KEY=crsr_...' > agent/.env       # paste your Cursor key
(cd agent && bun install && npm run agent)        # uses node + @cursor/sdk
```

> Why `npm run agent` not `bun run`? The Cursor SDK uses HTTP/2 via
> `@connectrpc`, which trips a `NGHTTP2_FRAME_SIZE_ERROR` on Bun today.
> Node 20+ works fine. `bun run agent:bun` is still wired for when Bun
> ships the fix. `bun install` for dependency management is unaffected.

Open the laptop browser at:

- `http://127.0.0.1:8000/` — operator HUD (auto-paid count, escalations,
  ledger, agent trace, "Run agent" / "Reset" buttons).
- `http://127.0.0.1:5173/` — XR scene with the same HUD overlaid. Click
  *Enter VR* on a WebXR-capable browser to put the cards in front of you.

### Cursor SDK + Specter MCP

The agent uses the **Cursor SDK** runtime (`@cursor/sdk`, `Agent.create({ model: "composer-2", local: { cwd }, mcpServers: { specter: ... } })`). On every escalation it calls the **Specter MCP server** (`specter-mcp/server.py`, real MCP over stdio) via the `lookup_vendor` tool, then writes a one-paragraph reason grounded in those Specter facts.

You'll see this in `[trace]` lines on the HUD:

```
cursor-sdk: spawning Agent (composer-2) with Specter MCP attached
cursor-sdk: tool call → mcp
cursor-sdk: thinking → Acme Holdings Ltd: incorporated 5 days ago…
cursor-sdk: tool mcp completed
cursor-sdk: status FINISHED
escalated INV-0048 Acme Holdings Ltd c=0.19: Acme Holdings Ltd is unknown to us and was incorporated on 2026-04-25 with Specter showing only one employee…
```

#### Swapping in the real Specter

Drop a real Specter URL in `agent/.env`:

```
SPECTER_UPSTREAM_URL=https://...
SPECTER_UPSTREAM_KEY=...
```

The `specter-mcp/server.py` shim will proxy `lookup_vendor` to
`{UPSTREAM_URL}/vendors/{vendor}` and the `source` field flips from
`"specter-local"` to `"specter"` automatically (the XR card UI shows this).

#### OpenAI fallback

If `CURSOR_API_KEY` is missing the agent skips the Cursor SDK call and uses
its local heuristic for the escalation reason. If `OPENAI_API_KEY` is set
instead, `score.ts` will route to gpt-4o-mini for scoring as a third option.

## Demo path (90 seconds)

1. Hit **Run agent** in the HUD. 47 invoices flush green into the ledger,
   three escalations appear as floating cards in the XR scene.
2. Walk up to a card. Trigger to grab — Specter enrichment renders inside the
   card (incorporation date, employee count, risk flags).
3. Squeeze the trigger to charge the green approval bar. The browser signs an
   Ed25519 `SignedApproval`, the server verifies it with the registered
   pubkey, the ledger gains a row, the card animates upward and disappears.
4. Pick up the next card, flick downward to reject — same signing flow,
   `decision: "reject"`, no money moves.
5. Tamper with a sig (or wrong pubkey) and the server returns 401. Card
   shakes red.

## Endpoints

```
POST /agent/run        local heuristic agent (used as a stub & fallback)
POST /agent/reset      mark every invoice unprocessed, clear ledger/trace/escalations
GET  /agent/trace      tail of trace lines (used by the HUD)
POST /agent/trace      agent → backend trace forwarding
GET  /invoices         list invoices (?unprocessed_only=true for the agent)
POST /auto_pay         agent posts safe invoices here
GET  /escalations      cards the XR scene renders
POST /escalations      agent posts ambiguous invoices here
POST /pubkey           browser registers its Ed25519 pubkey
POST /approve          signed approval/rejection, 401 on bad sig
GET  /ledger           full transaction log
GET  /specter/{vendor} mock enrichment proxy (Specter MCP slot)
```

## Notes / cuts

- Money is stored as integer pennies in `amount_gbp`. The UI divides by 100
  for display.
- Timestamps are unix ms.
- The Specter MCP slot is filled by `specter-mcp/server.py`, a real MCP
  server (FastMCP, stdio transport). Both `/specter/{vendor}` and the
  Cursor SDK agent call it. Responses are tagged `source: "specter-local"`.
  To swap in Francisco's hosted Specter, set `SPECTER_UPSTREAM_URL` (and
  `SPECTER_UPSTREAM_KEY`) — the shim proxies and the source flips to
  `"specter"`.
- Reject is detected via downward angular velocity on the grabbed
  controller; tune `REJECT_FLICK_THRESHOLD` in `xr/src/main.ts` for your
  hardware. On laptop fallback: `a` approves, `r` rejects the hovered card.
- We never call real money rails. `/approve` only writes a ledger row.

## Definition of done

- [x] `bun run agent/run.ts` processes all invoices, posts to backend
- [x] Open XR page, see 3 cards in space
- [x] Grab a card, see Specter enrichment
- [x] Approve a card, ledger updates, signature verifies
- [x] Reject a card, it disappears, no ledger change
- [x] Laptop mirror is legible from 3 metres (`http://127.0.0.1:8000/`)
- [x] Demo runs end-to-end in under 90 seconds without restart
