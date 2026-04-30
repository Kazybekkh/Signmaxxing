// Human-readable escalation reasoning with gpt-4o.
//
// Only called for invoices the scorer flagged for escalation. We want a
// punchy explanation a finance person can read on the floating XR card.

import type { Invoice } from "../shared/types.ts";
import OpenAI from "openai";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";

let _openai: OpenAI | null = null;
function openai(): OpenAI | null {
  if (_openai) return _openai;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  _openai = new OpenAI({ apiKey: key, baseURL: GEMINI_BASE });
  return _openai;
}

const REASON_SYSTEM = `You explain payments risk to a busy finance lead.
You will receive an invoice and a short risk reason from an automated scorer.
Write 2-3 sentences (max 60 words total) explaining what is unusual and what to
check before approving. Mention the vendor by name. Do not invent facts.
Plain English, no bullets, no headers.`;

export async function explainEscalation(
  inv: Invoice,
  shortReason: string,
): Promise<string> {
  const client = openai();
  if (!client) {
    return shortReasonFallback(inv, shortReason);
  }
  try {
    const resp = await client.chat.completions.create({
      model: process.env.GEMINI_REASON_MODEL ?? "gemini-2.5-flash",
      temperature: 0.2,
      messages: [
        { role: "system", content: REASON_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            invoice: {
              vendor: inv.vendor,
              amount_gbp_pennies: inv.amount_gbp,
              description: inv.description,
              due_date: inv.due_date,
              vendor_metadata: inv.vendor_metadata,
            },
            short_reason: shortReason,
          }),
        },
      ],
    });
    const text = resp.choices[0]?.message?.content?.trim();
    if (!text) return shortReasonFallback(inv, shortReason);
    return text;
  } catch (err) {
    console.warn(
      `[reason] OpenAI failed for ${inv.id}, using fallback:`,
      (err as Error).message,
    );
    return shortReasonFallback(inv, shortReason);
  }
}

function shortReasonFallback(inv: Invoice, shortReason: string): string {
  const amount = `£${(inv.amount_gbp / 100).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return `${inv.vendor} is requesting ${amount} for "${inv.description}". Risk signals: ${shortReason}. Verify the vendor's identity and the contract before approving.`;
}
