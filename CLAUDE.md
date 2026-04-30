# Signmaxxing: Build Instructions for Cursor

You are building **Signmaxxing**, a hackathon submission for Cursor Hack London 2026 (Track 01: Money Movement). Read this whole file before writing code. Do not deviate from the architecture without asking.

## What we're building

A WebXR approval room. A Cursor SDK agent processes a batch of fake invoices, auto-pays the safe ones, and floats the ambiguous ones into 3D space as cards. The user (wearing a Zapbox headset) walks up, inspects the card (with Specter MCP enrichment), and approves or rejects via controller gesture. Approvals are signed Ed25519 and verified server-side before "execution".

## Hard constraints

- **Time budget: 8 hours.** Skip anything not on the build order.
- **No real money rails.** Mock everything. No Stripe, no Plaid.
- **Demo must mirror to laptop.** Judges watch the laptop, not the headset.
- **90-second demo.** Every feature must earn its slot in that window.

## Tech stack (do not substitute)

| Layer | Choice | Notes |
|---|---|---|
| Backend | FastAPI + SQLite | one file `main.py`, in-memory db is fine |
| Agent | Cursor SDK (TypeScript) | `@cursor/sdk`, run via `bun run` |
| Frontend | Vite + Three.js + WebXR | no React Three Fiber, raw Three.js |
| Signing | tweetnacl-js | Ed25519, browser-side keypair |
| MCP | Specter MCP | get URL/key from Francisco on Discord |
| Models | OpenAI API, gpt-4o-mini for scoring, gpt-4o for reasoning | swap if Anthropic credits given |
| Styling | tailwind CDN for HUD only | XR scene is pure Three.js |

## File structure

```
signmaxxing/
├── backend/
│   ├── main.py                 # FastAPI app, all endpoints
│   ├── seed.py                 # generates 50 invoices into SQLite
│   ├── invoices.db             # gitignored
│   └── requirements.txt
├── agent/
│   ├── run.ts                  # Cursor SDK agent entrypoint
│   ├── score.ts                # confidence scoring (gpt-4o-mini)
│   ├── reason.ts               # escalation reasoning (gpt-4o)
│   └── package.json
├── xr/
│   ├── index.html              # WebXR entry, mirrors HUD
│   ├── main.ts                 # Three.js scene, controller logic
│   ├── card.ts                 # Card mesh + interaction
│   ├── sign.ts                 # tweetnacl wrapper
│   └── api.ts                  # backend client
├── shared/
│   └── types.ts                # Invoice, Card, SignedApproval
└── README.md
```

## API contract (build backend + frontend in parallel against this)

```ts
// shared/types.ts
type Invoice = {
  id: string;
  vendor: string;
  amount_gbp: number;
  description: string;
  due_date: string;
  vendor_metadata: { domain?: string; incorporated?: string; country?: string };
};

type Card = {
  invoice: Invoice;
  confidence: number;        // 0..1
  reason: string;            // why escalated
  enrichment?: SpecterData;  // populated client-side
};

type SignedApproval = {
  invoice_id: string;
  decision: "approve" | "reject";
  timestamp: number;
  pubkey: string;            // base64
  signature: string;         // base64, signs JSON.stringify of above 4 fields
};
```

### Endpoints

- `POST /agent/run` → kicks agent over all unprocessed invoices, returns `{ auto_paid: Invoice[], escalated: Card[] }`
- `GET /escalations` → returns current `Card[]`
- `POST /approve` → body `SignedApproval`, verifies sig with stored pubkey, updates ledger, returns `{ status: "executed" | "rejected" }`
- `GET /ledger` → returns full transaction log for HUD
- `POST /pubkey` → register browser pubkey (called once on XR load)

## Build order (strict)

### Phase 1: Backend (60 min)
1. FastAPI app with the 5 endpoints above, all returning mock data first.
2. `seed.py` generates 50 invoices: 40 obviously-fine (known vendors, small amounts), 7 borderline (large amounts), 3 sketchy (unknown vendors, weird domains, recent incorporation).
3. SQLite tables: `invoices`, `ledger`, `pubkeys`.
4. Confirm with `curl`: `/agent/run` returns escalations, `/approve` with bad sig returns 401.

### Phase 2: Agent (90 min)
1. `run.ts` reads `/invoices`, calls `score.ts` per invoice.
2. `score.ts`: prompts gpt-4o-mini with invoice + heuristics, returns `{confidence, reason}`. Confidence < 0.85 → escalate.
3. `reason.ts`: for escalated only, calls gpt-4o for human-readable explanation.
4. Agent posts auto-pays directly via internal endpoint, posts escalations to `/escalations`.
5. Run via Cursor SDK runtime (not raw node) for the bonus point. Log trace.

### Phase 3: XR scene (120 min)
1. Vite + Three.js boilerplate, WebXR session button.
2. Fetch `/escalations`, render each as a floating card mesh in a semicircle in front of user.
3. Card visuals: height proportional to amount, color from green→red by confidence, vendor name + amount as text texture.
4. Controller raycast: hover highlights, trigger grabs.
5. Once grabbed: card enlarges, shows full reasoning text + Specter enrichment.
6. Two-step gesture: squeeze trigger to approve, flick down to reject. Two-step prevents accidents.

### Phase 4: Signing (45 min)
1. On page load, generate Ed25519 keypair, POST pubkey to `/pubkey`.
2. On approve gesture, build `SignedApproval`, sign with tweetnacl, POST to `/approve`.
3. Card animates out on success, shakes on failure.

### Phase 5: Specter MCP (45 min)
1. Get access from Francisco. URL goes in `.env`.
2. On card grab, fire MCP query for vendor name/domain.
3. Inject incorporation date, employee count, risk flags into card display.
4. Cache responses, MCP can be slow.

### Phase 6: HUD + mirror (60 min)
1. Outside the XR session, render a 2D HUD at `/`: agent trace, ledger, current escalations count, "auto-paid: 47 / escalated: 3".
2. Cast iPhone screen via QuickTime to laptop, project laptop to demo screen.
3. Practice the 90-second script three times.

## Conventions

- TypeScript strict, no `any` outside MCP response handling.
- All money in pennies (integers), display as GBP.
- All timestamps unix ms.
- Errors: throw, don't silently catch. Hackathon = visible failures > silent bugs.
- No tests. We have 8 hours.
- Commit after each phase with the phase name.

## Demo data shape (in seed.py)

- 30 small recurring vendors (AWS, GitHub, Notion, Linear): low amount, known domain, auto-pay.
- 10 medium known vendors: variable amount, auto-pay.
- 7 large known vendors: amount above £5k threshold, escalate for size.
- 3 sketchy: "Acme Holdings Ltd" (incorporated 2026-04-25), "Nexus Global Trading" (no domain), "QuickPay Solutions" (.tk domain). Escalate for risk.

After agent run: 47 auto-paid, 3 escalated. The 3 escalations are the demo.

## Don'ts

- Do NOT add auth, accounts, or login flow.
- Do NOT use a database ORM. Raw SQL via sqlite3 module.
- Do NOT use React Three Fiber, it adds 30 min of setup pain.
- Do NOT let the agent loop forever. Hard cap at one pass over invoices.
- Do NOT polish the 2D HUD beyond legibility.
- Do NOT name files with the old name "Guardmaxxing". This is Signmaxxing.

## Definition of done

- [ ] `bun run agent/run.ts` processes all invoices, posts to backend
- [ ] Open XR page, see 3 cards in space
- [ ] Grab a card, see Specter enrichment
- [ ] Approve a card, ledger updates, signature verifies
- [ ] Reject a card, it disappears, no ledger change
- [ ] Laptop mirror is legible from 3 metres
- [ ] Demo runs end-to-end in under 90 seconds without restart

## When you're stuck

Stop and write a one-line summary of the blocker in chat. Do not silently downgrade scope. The cuts list in `signmaxxing-spec.md` is the only sanctioned scope reduction.
