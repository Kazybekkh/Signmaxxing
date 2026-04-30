"""Generate 53 demo invoices.

40 obviously-fine, 7 borderline (large), 6 sketchy. After agent run we
expect 47 auto-paid and 6 escalated."""

from __future__ import annotations

import json
import random
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "invoices.db"

random.seed(42)

KNOWN_VENDORS_SMALL = [
    ("AWS", "aws.amazon.com", "2003-03-14"),
    ("GitHub", "github.com", "2008-04-10"),
    ("Notion", "notion.so", "2016-03-01"),
    ("Linear", "linear.app", "2019-05-29"),
    ("Vercel", "vercel.com", "2015-04-15"),
    ("Datadog", "datadoghq.com", "2010-07-01"),
    ("Sentry", "sentry.io", "2012-01-15"),
    ("Cloudflare", "cloudflare.com", "2009-07-17"),
    ("PostHog", "posthog.com", "2020-01-13"),
    ("Slack", "slack.com", "2013-08-01"),
    ("1Password", "1password.com", "2005-04-23"),
    ("Figma", "figma.com", "2012-09-13"),
]

KNOWN_VENDORS_MEDIUM = [
    ("OpenAI", "openai.com", "2015-12-11"),
    ("Anthropic", "anthropic.com", "2021-01-01"),
    ("HashiCorp", "hashicorp.com", "2012-08-08"),
    ("DigitalOcean", "digitalocean.com", "2011-06-24"),
    ("Stripe", "stripe.com", "2010-09-23"),
    ("Zoom", "zoom.us", "2011-04-01"),
    ("Google Workspace", "google.com", "1998-09-04"),
    ("Microsoft 365", "microsoft.com", "1975-04-04"),
]


SKETCHY = [
    {
        "vendor": "Acme Holdings Ltd",
        "amount_gbp": 1_245_00,  # pennies (display £1,245.00)
        "description": "Strategic consulting Q2 invoice 0001",
        "vendor_metadata": {
            "domain": "acme-holdings.co",
            "incorporated": "2026-04-25",
            "country": "GB",
        },
    },
    {
        "vendor": "Nexus Global Trading",
        "amount_gbp": 8_320_00,
        "description": "Wholesale procurement reference NGT-9981",
        "vendor_metadata": {
            "domain": None,
            "incorporated": "2024-11-02",
            "country": "AE",
        },
    },
    {
        "vendor": "QuickPay Solutions",
        "amount_gbp": 4_680_00,
        "description": "Payment processing onboarding fee",
        "vendor_metadata": {
            "domain": "quickpay-solutions.tk",
            "incorporated": "2025-09-12",
            "country": "SC",
        },
    },
    {
        "vendor": "Velocity Marketing Group",
        "amount_gbp": 14_250_00,
        "description": "Q2 brand-uplift retainer (paid in advance) ref VMG-7714",
        "vendor_metadata": {
            "domain": None,
            "incorporated": "2026-02-01",
            "country": "GB",
        },
    },
    {
        "vendor": "Synergy Capital Partners",
        "amount_gbp": 22_750_00,
        "description": "Advisory services — Project Halcyon, milestone 1 of 2",
        "vendor_metadata": {
            "domain": "synergy-capital.xyz",
            "incorporated": "2025-08-30",
            "country": "KY",
        },
    },
    {
        "vendor": "TrueWave Technologies LLC",
        "amount_gbp": 6_490_00,
        "description": "URGENT: software licensing renewal, please remit within 24h",
        "vendor_metadata": {
            "domain": "truewave-tech.cf",
            "incorporated": "2026-03-10",
            "country": "SC",
        },
    },
]


def _due_date_in_future(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).date().isoformat()


def _build_invoice(idx: int) -> dict:
    if idx < 30:
        vendor, domain, incorporated = random.choice(KNOWN_VENDORS_SMALL)
        amount = random.randint(15_00, 250_00)
        desc = f"Monthly subscription #{1000 + idx}"
    elif idx < 40:
        vendor, domain, incorporated = random.choice(KNOWN_VENDORS_MEDIUM)
        amount = random.randint(400_00, 2_400_00)
        desc = f"Usage invoice #{2000 + idx}"
    elif idx < 47:
        vendor, domain, incorporated = random.choice(KNOWN_VENDORS_MEDIUM)
        amount = random.randint(5_500_00, 18_000_00)
        desc = f"Annual contract renewal #{3000 + idx}"
    else:
        sketchy = SKETCHY[idx - 47]

        return {
            "id": f"INV-{idx+1:04d}",
            "vendor": sketchy["vendor"],
            "amount_gbp": sketchy["amount_gbp"],
            "description": sketchy["description"],
            "due_date": _due_date_in_future(random.randint(2, 14)),
            "vendor_metadata": sketchy["vendor_metadata"],
        }

    return {
        "id": f"INV-{idx+1:04d}",
        "vendor": vendor,
        "amount_gbp": amount,
        "description": desc,
        "due_date": _due_date_in_future(random.randint(3, 30)),
        "vendor_metadata": {
            "domain": domain,
            "incorporated": incorporated,
            "country": "US" if vendor != "Microsoft 365" else "US",
        },
    }


def seed(reset: bool = True) -> int:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        # ensure tables exist (call into main.init_db)
        sys.path.insert(0, str(Path(__file__).parent))
        from main import init_db  # type: ignore

        init_db()

        if reset:
            conn.execute("DELETE FROM ledger")
            conn.execute("DELETE FROM escalations")
            conn.execute("DELETE FROM invoices")
            conn.execute("DELETE FROM agent_trace")

        invoices = [_build_invoice(i) for i in range(47 + len(SKETCHY))]
        for inv in invoices:
            conn.execute(
                """
                INSERT INTO invoices
                  (id, vendor, amount_gbp, description, due_date, vendor_metadata, processed)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    inv["id"],
                    inv["vendor"],
                    int(inv["amount_gbp"]),
                    inv["description"],
                    inv["due_date"],
                    json.dumps(inv["vendor_metadata"]),
                ),
            )
        conn.commit()
        return len(invoices)
    finally:
        conn.close()


if __name__ == "__main__":
    n = seed(reset=True)
    print(f"seeded {n} invoices into {DB_PATH}")
