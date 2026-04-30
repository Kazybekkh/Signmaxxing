"""Heuristic scoring shared between the agent and the backend stub.

The Cursor SDK agent uses GPT for the actual scoring, but we want a
deterministic local fallback so the demo cannot fail because the OpenAI key
is missing or rate-limited. Both paths must agree on the *same set of
escalations* for the seeded data (currently 6 sketchy vendors out of 57
invoices → 51 auto-paid, 6 escalated)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Tuple

# Anything we have done business with before.
KNOWN_VENDORS = {
    "AWS",
    "GitHub",
    "Notion",
    "Linear",
    "Vercel",
    "Datadog",
    "Sentry",
    "Stripe",
    "Cloudflare",
    "OpenAI",
    "Anthropic",
    "PostHog",
    "Slack",
    "Zoom",
    "Figma",
    "1Password",
    "Google Workspace",
    "Microsoft 365",
    "DigitalOcean",
    "HashiCorp",
}

LARGE_AMOUNT_PENNIES = 500_000  # £5,000
SUSPICIOUS_TLDS = {".tk", ".ml", ".ga", ".cf", ".gq", ".top", ".xyz"}


def _years_old(iso_date: str | None) -> float:
    if not iso_date:
        return -1.0
    try:
        d = datetime.fromisoformat(iso_date)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - d
        return delta.days / 365.25
    except Exception:
        return -1.0


def score_invoice(invoice: dict[str, Any]) -> Tuple[float, str]:
    """Return (confidence, reason). Confidence < 0.85 means escalate."""
    vendor = str(invoice.get("vendor", ""))
    amount = int(invoice.get("amount_gbp", 0))
    metadata = invoice.get("vendor_metadata") or {}
    domain = (metadata.get("domain") or "").lower()
    incorporated = metadata.get("incorporated")

    flags: list[str] = []
    confidence = 0.99

    is_known = vendor in KNOWN_VENDORS

    if not is_known:
        confidence -= 0.4
        flags.append(f"unknown vendor '{vendor}'")

    if not domain:
        confidence -= 0.25
        flags.append("no public domain on file")
    else:
        for tld in SUSPICIOUS_TLDS:
            if domain.endswith(tld):
                confidence -= 0.5
                flags.append(f"suspicious TLD {tld}")
                break

    age = _years_old(incorporated)
    if age >= 0 and age < 1:
        confidence -= 0.4
        flags.append(f"vendor incorporated only {age*12:.0f} months ago")

    if amount >= LARGE_AMOUNT_PENNIES:
        # Large amount only erodes confidence when paired with another red flag.
        # Spec target: 51 auto-paid, 6 escalated (the seeded sketchy vendors).
        if not is_known:
            confidence -= 0.2
            flags.append(f"amount £{amount/100:,.2f} above £5k threshold")

    confidence = max(0.0, min(1.0, confidence))

    if not flags:
        reason = f"known vendor {vendor}, normal recurring spend"
    else:
        reason = "; ".join(flags)

    return confidence, reason
