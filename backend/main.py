"""Signmaxxing backend.

Single-file FastAPI app. Raw sqlite3, no ORM. Mirrors `shared/types.ts`.
Money is stored as integer pennies in `amount_gbp`. Times are unix ms.
"""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent / "invoices.db"

app = FastAPI(title="Signmaxxing", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS invoices (
                id TEXT PRIMARY KEY,
                vendor TEXT NOT NULL,
                amount_gbp INTEGER NOT NULL,
                description TEXT NOT NULL,
                due_date TEXT NOT NULL,
                vendor_metadata TEXT NOT NULL,
                processed INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS escalations (
                invoice_id TEXT PRIMARY KEY,
                confidence REAL NOT NULL,
                reason TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (invoice_id) REFERENCES invoices (id)
            );

            CREATE TABLE IF NOT EXISTS ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id TEXT NOT NULL,
                vendor TEXT NOT NULL,
                amount_gbp INTEGER NOT NULL,
                decision TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                trace TEXT
            );

            CREATE TABLE IF NOT EXISTS pubkeys (
                pubkey TEXT PRIMARY KEY,
                registered_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_trace (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                step INTEGER NOT NULL,
                line TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            """
        )


init_db()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class VendorMetadata(BaseModel):
    domain: Optional[str] = None
    incorporated: Optional[str] = None
    country: Optional[str] = None


class Invoice(BaseModel):
    id: str
    vendor: str
    amount_gbp: int
    description: str
    due_date: str
    vendor_metadata: VendorMetadata


class Card(BaseModel):
    invoice: Invoice
    confidence: float
    reason: str


class SignedApproval(BaseModel):
    invoice_id: str
    decision: Literal["approve", "reject"]
    timestamp: int
    pubkey: str
    signature: str


class PubkeyBody(BaseModel):
    pubkey: str = Field(..., description="base64-encoded Ed25519 public key (32 bytes)")


class EscalationBody(BaseModel):
    invoice_id: str
    confidence: float
    reason: str


class AutoPayBody(BaseModel):
    invoice_id: str
    confidence: float
    reason: str


class TraceBody(BaseModel):
    run_id: str
    line: str


# ---------------------------------------------------------------------------
# Mappers
# ---------------------------------------------------------------------------


def row_to_invoice(row: sqlite3.Row) -> Invoice:
    return Invoice(
        id=row["id"],
        vendor=row["vendor"],
        amount_gbp=int(row["amount_gbp"]),
        description=row["description"],
        due_date=row["due_date"],
        vendor_metadata=VendorMetadata(**json.loads(row["vendor_metadata"])),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, Any]:
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) AS c FROM invoices").fetchone()["c"]
    return {"ok": True, "invoices": int(n)}


@app.get("/invoices")
def list_invoices(unprocessed_only: bool = False) -> list[Invoice]:
    with db() as conn:
        if unprocessed_only:
            rows = conn.execute(
                "SELECT * FROM invoices WHERE processed = 0 ORDER BY id"
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM invoices ORDER BY id").fetchall()
    return [row_to_invoice(r) for r in rows]


@app.get("/escalations")
def list_escalations() -> list[Card]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT i.*, e.confidence, e.reason
            FROM escalations e
            JOIN invoices i ON i.id = e.invoice_id
            WHERE i.processed = 0
            ORDER BY e.created_at ASC
            """
        ).fetchall()
    cards: list[Card] = []
    for r in rows:
        cards.append(
            Card(
                invoice=row_to_invoice(r),
                confidence=float(r["confidence"]),
                reason=str(r["reason"]),
            )
        )
    return cards


@app.post("/escalations")
def create_escalation(body: EscalationBody) -> dict[str, str]:
    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM invoices WHERE id = ?", (body.invoice_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(404, f"invoice {body.invoice_id} not found")
        conn.execute(
            """
            INSERT OR REPLACE INTO escalations (invoice_id, confidence, reason, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (body.invoice_id, body.confidence, body.reason, int(time.time() * 1000)),
        )
    return {"status": "escalated"}


@app.post("/auto_pay")
def auto_pay(body: AutoPayBody) -> dict[str, str]:
    """Internal endpoint hit by the agent for safe invoices."""
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM invoices WHERE id = ?", (body.invoice_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, f"invoice {body.invoice_id} not found")
        if int(row["processed"]) == 1:
            return {"status": "already_processed"}
        conn.execute(
            """
            INSERT INTO ledger (invoice_id, vendor, amount_gbp, decision, timestamp, trace)
            VALUES (?, ?, ?, 'auto_pay', ?, ?)
            """,
            (
                row["id"],
                row["vendor"],
                int(row["amount_gbp"]),
                int(time.time() * 1000),
                f"agent confidence {body.confidence:.2f}: {body.reason}",
            ),
        )
        conn.execute("UPDATE invoices SET processed = 1 WHERE id = ?", (row["id"],))
    return {"status": "executed"}


@app.post("/pubkey")
def register_pubkey(body: PubkeyBody) -> dict[str, Any]:
    try:
        raw = base64.b64decode(body.pubkey)
    except Exception as e:
        raise HTTPException(400, f"invalid base64: {e}")
    if len(raw) != 32:
        raise HTTPException(400, "Ed25519 pubkey must be 32 bytes")
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO pubkeys (pubkey, registered_at) VALUES (?, ?)",
            (body.pubkey, int(time.time() * 1000)),
        )
    return {"status": "registered", "pubkey": body.pubkey}


@app.post("/approve")
def approve(body: SignedApproval) -> dict[str, str]:
    with db() as conn:
        pk_row = conn.execute(
            "SELECT pubkey FROM pubkeys WHERE pubkey = ?", (body.pubkey,)
        ).fetchone()
        if not pk_row:
            raise HTTPException(401, "unknown pubkey")

        try:
            pubkey_bytes = base64.b64decode(body.pubkey)
            sig_bytes = base64.b64decode(body.signature)
        except Exception as e:
            raise HTTPException(400, f"bad base64: {e}")

        message = json.dumps(
            {
                "invoice_id": body.invoice_id,
                "decision": body.decision,
                "timestamp": body.timestamp,
                "pubkey": body.pubkey,
            },
            separators=(",", ":"),
            sort_keys=False,
        ).encode("utf-8")

        try:
            VerifyKey(pubkey_bytes).verify(message, sig_bytes)
        except BadSignatureError:
            raise HTTPException(401, "bad signature")

        invoice_row = conn.execute(
            "SELECT * FROM invoices WHERE id = ?", (body.invoice_id,)
        ).fetchone()
        if not invoice_row:
            raise HTTPException(404, "invoice not found")

        decision = body.decision
        if decision == "approve":
            conn.execute(
                """
                INSERT INTO ledger (invoice_id, vendor, amount_gbp, decision, timestamp, trace)
                VALUES (?, ?, ?, 'approve', ?, ?)
                """,
                (
                    invoice_row["id"],
                    invoice_row["vendor"],
                    int(invoice_row["amount_gbp"]),
                    body.timestamp,
                    f"signed approval pubkey={body.pubkey[:12]}...",
                ),
            )
            status = "executed"
        else:
            conn.execute(
                """
                INSERT INTO ledger (invoice_id, vendor, amount_gbp, decision, timestamp, trace)
                VALUES (?, ?, 0, 'reject', ?, ?)
                """,
                (
                    invoice_row["id"],
                    invoice_row["vendor"],
                    body.timestamp,
                    f"signed rejection pubkey={body.pubkey[:12]}...",
                ),
            )
            status = "rejected"

        conn.execute(
            "UPDATE invoices SET processed = 1 WHERE id = ?", (invoice_row["id"],)
        )
        conn.execute(
            "DELETE FROM escalations WHERE invoice_id = ?", (invoice_row["id"],)
        )

    return {"status": status}


@app.get("/ledger")
def ledger() -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM ledger ORDER BY timestamp DESC, id DESC"
        ).fetchall()
    return [
        {
            "id": int(r["id"]),
            "invoice_id": r["invoice_id"],
            "vendor": r["vendor"],
            "amount_gbp": int(r["amount_gbp"]),
            "decision": r["decision"],
            "timestamp": int(r["timestamp"]),
            "trace": r["trace"],
        }
        for r in rows
    ]


@app.post("/agent/trace")
def add_trace(body: TraceBody) -> dict[str, str]:
    with db() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS c FROM agent_trace WHERE run_id = ?", (body.run_id,)
        ).fetchone()["c"]
        conn.execute(
            """
            INSERT INTO agent_trace (run_id, step, line, timestamp)
            VALUES (?, ?, ?, ?)
            """,
            (body.run_id, int(n) + 1, body.line, int(time.time() * 1000)),
        )
    return {"status": "logged"}


@app.get("/agent/trace")
def get_trace(run_id: Optional[str] = None, limit: int = 100) -> list[dict[str, Any]]:
    with db() as conn:
        if run_id:
            rows = conn.execute(
                "SELECT * FROM agent_trace WHERE run_id = ? ORDER BY id DESC LIMIT ?",
                (run_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM agent_trace ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
    return [
        {
            "id": int(r["id"]),
            "run_id": r["run_id"],
            "step": int(r["step"]),
            "line": r["line"],
            "timestamp": int(r["timestamp"]),
        }
        for r in rows
    ]


@app.post("/agent/reset")
def reset_run() -> dict[str, Any]:
    """Mark every invoice as unprocessed and clear escalations + ledger.

    Useful when re-running the demo without reseeding."""
    with db() as conn:
        conn.execute("UPDATE invoices SET processed = 0")
        conn.execute("DELETE FROM escalations")
        conn.execute("DELETE FROM ledger")
        conn.execute("DELETE FROM agent_trace")
    return {"status": "reset"}


# ---------------------------------------------------------------------------
# Specter MCP proxy
# ---------------------------------------------------------------------------

# In production we would call Francisco's Specter MCP here. Until we get a
# URL/key the proxy returns the same canned data the XR client falls back to,
# so the demo is end-to-end consistent.

SPECTER_FIXTURES: dict[str, dict[str, Any]] = {
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
        "source": "mock",
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
        "source": "mock",
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
        "source": "mock",
    },
}


@app.get("/specter/{vendor}")
def specter(vendor: str) -> dict[str, Any]:
    fixture = SPECTER_FIXTURES.get(vendor)
    if fixture:
        return fixture
    return {
        "vendor": vendor,
        "domain": None,
        "incorporation_date": None,
        "employee_count": None,
        "risk_flags": ["No Specter record found"],
        "source": "mock",
    }


@app.post("/agent/run")
def agent_run_stub() -> dict[str, Any]:
    """The real agent lives in `agent/run.ts` (Cursor SDK).

    This stub exists so a curl smoke test still works and so the HUD button
    can fall back to a deterministic local run if the agent service is down.
    It runs purely heuristic scoring server-side.
    """
    from heuristics import score_invoice  # type: ignore

    auto_paid: list[Invoice] = []
    escalated: list[Card] = []
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM invoices WHERE processed = 0 ORDER BY id"
        ).fetchall()
        for r in rows:
            inv = row_to_invoice(r)
            confidence, reason = score_invoice(inv.model_dump())
            if confidence < 0.85:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO escalations (invoice_id, confidence, reason, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (inv.id, confidence, reason, int(time.time() * 1000)),
                )
                escalated.append(
                    Card(invoice=inv, confidence=confidence, reason=reason)
                )
            else:
                conn.execute(
                    """
                    INSERT INTO ledger (invoice_id, vendor, amount_gbp, decision, timestamp, trace)
                    VALUES (?, ?, ?, 'auto_pay', ?, ?)
                    """,
                    (
                        inv.id,
                        inv.vendor,
                        inv.amount_gbp,
                        int(time.time() * 1000),
                        f"heuristic confidence {confidence:.2f}: {reason}",
                    ),
                )
                conn.execute(
                    "UPDATE invoices SET processed = 1 WHERE id = ?", (inv.id,)
                )
                auto_paid.append(inv)
    return {"auto_paid": [i.model_dump() for i in auto_paid], "escalated": [c.model_dump() for c in escalated]}


# ---------------------------------------------------------------------------
# Static HUD (Phase 6)
# ---------------------------------------------------------------------------

HUD_DIR = Path(__file__).parent / "hud"
HUD_DIR.mkdir(exist_ok=True)
app.mount("/hud", StaticFiles(directory=str(HUD_DIR), html=True), name="hud")


@app.get("/", response_class=HTMLResponse)
def root() -> str:
    hud_index = HUD_DIR / "index.html"
    if hud_index.exists():
        return hud_index.read_text()
    return (
        "<!doctype html><html><body style='font-family:sans-serif;padding:2rem'>"
        "<h1>Signmaxxing backend</h1>"
        "<p>HUD not built yet. Try <a href='/docs'>/docs</a>.</p>"
        "</body></html>"
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=True,
    )
