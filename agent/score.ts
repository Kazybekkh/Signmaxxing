// Confidence scoring with gpt-4o-mini.
//
// Returns { confidence, reason } per invoice. Confidence < 0.85 means
// escalate. If OPENAI_API_KEY is missing, falls back to a deterministic
// heuristic so the demo never breaks.

import type { Invoice } from "../shared/types.ts";
import OpenAI from "openai";

export type Score = { confidence: number; reason: string };

const KNOWN_VENDORS = new Set([
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
]);

const SUSPICIOUS_TLDS = [".tk", ".ml", ".ga", ".cf", ".gq", ".top", ".xyz"];

function heuristicScore(inv: Invoice): Score {
  const flags: string[] = [];
  let confidence = 0.99;
  const known = KNOWN_VENDORS.has(inv.vendor);
  const domain = (inv.vendor_metadata.domain ?? "").toLowerCase();
  const incorporated = inv.vendor_metadata.incorporated;

  if (!known) {
    confidence -= 0.4;
    flags.push(`unknown vendor '${inv.vendor}'`);
  }
  if (!domain) {
    confidence -= 0.25;
    flags.push("no public domain on file");
  } else {
    const bad = SUSPICIOUS_TLDS.find((t) => domain.endsWith(t));
    if (bad) {
      confidence -= 0.5;
      flags.push(`suspicious TLD ${bad}`);
    }
  }
  if (incorporated) {
    const ageDays =
      (Date.now() - new Date(incorporated).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= 0 && ageDays < 365) {
      confidence -= 0.4;
      flags.push(
        `vendor incorporated only ${Math.round(ageDays / 30)} months ago`,
      );
    }
  }
  if (!known && inv.amount_gbp >= 500_000) {
    confidence -= 0.2;
    flags.push(`amount £${(inv.amount_gbp / 100).toFixed(2)} above £5k threshold`);
  }

  confidence = Math.min(1, Math.max(0, confidence));
  const reason = flags.length
    ? flags.join("; ")
    : `known vendor ${inv.vendor}, normal recurring spend`;
  return { confidence, reason };
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";

let _openai: OpenAI | null = null;
function openai(): OpenAI | null {
  if (_openai) return _openai;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  _openai = new OpenAI({ apiKey: key, baseURL: GEMINI_BASE });
  return _openai;
}

const SCORE_SYSTEM = `You are a payments risk scorer. Given a single invoice JSON,
return STRICT JSON of the form {"confidence": number, "reason": string}.

Confidence is 0..1 where 1 = obviously safe to auto-pay, 0 = obviously fraud.
Apply these rules:
- Known SaaS vendors (AWS, GitHub, Notion, Linear, Stripe, Cloudflare, OpenAI, Anthropic,
  Slack, Zoom, Figma, Datadog, Sentry, HashiCorp, DigitalOcean, Vercel, PostHog,
  Google Workspace, Microsoft 365, 1Password) at any reasonable amount are safe (>=0.9).
- Unknown vendors: drop confidence sharply (<0.5).
- Missing domain or suspicious TLD (.tk, .ml, .xyz, .top): drop further.
- Vendor incorporated within the last 12 months when also unknown: drop further.
- Reason must be one short sentence with the specific red flags.

Reply with JSON only, no prose.`;

export async function scoreInvoice(inv: Invoice): Promise<Score> {
  const client = openai();
  if (!client) return heuristicScore(inv);

  try {
    const resp = await client.chat.completions.create({
      model: process.env.GEMINI_SCORE_MODEL ?? "gemini-2.5-flash",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SCORE_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            vendor: inv.vendor,
            amount_gbp_pennies: inv.amount_gbp,
            description: inv.description,
            due_date: inv.due_date,
            vendor_metadata: inv.vendor_metadata,
          }),
        },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as { confidence?: number; reason?: string };
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
    const reason = String(parsed.reason ?? "no reason returned");
    return { confidence, reason };
  } catch (err) {
    console.warn(
      `[score] OpenAI call failed for ${inv.id}, falling back to heuristic:`,
      (err as Error).message,
    );
    return heuristicScore(inv);
  }
}
