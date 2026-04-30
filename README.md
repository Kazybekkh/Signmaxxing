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
| `agent/` | Cursor SDK / TypeScript agent. `run.ts` orchestrates `score.ts` (gpt-4o-mini) and `reason.ts` (gpt-4o), with heuristic fallback so the demo cannot fail without an `OPENAI_API_KEY`. |
| `xr/` | Vite + raw Three.js. `main.ts` builds the scene, `card.ts` is the floating invoice mesh, `sign.ts` wraps tweetnacl, `specter.ts` does cached MCP lookups. |
| `shared/types.ts` | Single source of truth for `Invoice`, `Card`, `SignedApproval` etc. |
| `scripts/` | One-shot smoke scripts (`e2e.ts`, `sign_roundtrip.ts`). |

## Quickstart

Three terminals.

```bash
# 1. Backend (port 8000) — also serves the HUD at http://127.0.0.1:8000/
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
(cd backend && ../.venv/bin/python seed.py)
(cd backend && ../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload)

# 2. XR (port 5173) — open on the headset
(cd xr && bun install && bun run dev)

# 3. Agent (one-shot per demo run)
(cd agent && bun install && bun run run.ts)
```

Open the laptop browser at:

- `http://127.0.0.1:8000/` — operator HUD (auto-paid count, escalations,
  ledger, agent trace, "Run agent" / "Reset" buttons).
- `http://127.0.0.1:5173/` — XR scene with the same HUD overlaid. Click
  *Enter VR* on a WebXR-capable browser to put the cards in front of you.

### Optional: real LLM scoring

Without an API key the agent uses the same heuristic the backend stub uses.
With a key it routes scoring to gpt-4o-mini and reasoning to gpt-4o:

```bash
export OPENAI_API_KEY=sk-...
(cd agent && bun run run.ts)
```

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
- The Specter MCP credentials never arrived, so `/specter/{vendor}` and
  `xr/src/specter.ts` both serve canned data with `source: "mock"`. To swap
  in the real MCP, replace the body of the proxy in `backend/main.py` and
  keep the response shape.
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
