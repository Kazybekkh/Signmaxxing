// Cursor SDK agent entrypoint.
//
// Spec phase 2.5: "Run via Cursor SDK runtime (not raw node) for the bonus
// point. Log trace."
//
// Strategy:
//   1. Fetch invoices and score them locally with `score.ts` (deterministic,
//      cheap, lets the demo finish in <5s even on a flaky network).
//   2. For the small set of escalations, spin up a Cursor SDK Agent with the
//      Specter MCP server attached. Ask it to call `lookup_vendor` on each
//      vendor and emit a one-paragraph human-readable reason that grounds
//      the explanation in real Specter data.
//   3. Post the agent's reasoning to /escalations and stream every step to
//      /agent/trace so the laptop HUD shows real-time progress.
//
// Hard cap: one pass over invoices, one agent run.

import "dotenv/config";

import { Agent, type SDKMessage } from "@cursor/sdk";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Invoice } from "../shared/types.ts";
import { scoreInvoice } from "./score.ts";

const API = process.env.SIGNMAXXING_API ?? "http://127.0.0.1:8000";
const RUN_ID = `run-${Date.now()}`;
const CURSOR_API_KEY = process.env.CURSOR_API_KEY;
const CURSOR_MODEL = process.env.CURSOR_MODEL ?? "composer-2";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SPECTER_MCP_SCRIPT = resolve(ROOT, "specter-mcp/server.py");
const VENV_PYTHON = resolve(ROOT, ".venv/bin/python");
const PYTHON =
  existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.PYTHON ?? "python3";

async function postTrace(line: string): Promise<void> {
  console.log(`[trace] ${line}`);
  try {
    await fetch(`${API}/agent/trace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: RUN_ID, line }),
    });
  } catch (err) {
    console.warn(`[trace] backend unreachable: ${(err as Error).message}`);
  }
}

async function getInvoices(): Promise<Invoice[]> {
  const resp = await fetch(`${API}/invoices?unprocessed_only=true`);
  if (!resp.ok) throw new Error(`/invoices HTTP ${resp.status}`);
  return (await resp.json()) as Invoice[];
}

async function autoPay(
  inv: Invoice,
  confidence: number,
  reason: string,
): Promise<void> {
  const resp = await fetch(`${API}/auto_pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invoice_id: inv.id, confidence, reason }),
  });
  if (!resp.ok) throw new Error(`auto_pay ${inv.id} HTTP ${resp.status}`);
}

async function escalate(
  inv: Invoice,
  confidence: number,
  reason: string,
): Promise<void> {
  const resp = await fetch(`${API}/escalations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invoice_id: inv.id, confidence, reason }),
  });
  if (!resp.ok) throw new Error(`escalate ${inv.id} HTTP ${resp.status}`);
}

type Escalation = { inv: Invoice; confidence: number; shortReason: string };

async function reasonViaCursorSdk(
  escalations: Escalation[],
): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();

  if (!CURSOR_API_KEY) {
    await postTrace(
      "CURSOR_API_KEY missing → skipping Cursor SDK, using local fallback",
    );
    for (const e of escalations) {
      reasons.set(e.inv.id, fallbackReason(e));
    }
    return reasons;
  }

  await postTrace(
    `cursor-sdk: spawning Agent (${CURSOR_MODEL}) with Specter MCP attached`,
  );

  const agent = await Agent.create({
    apiKey: CURSOR_API_KEY,
    model: { id: CURSOR_MODEL },
    local: { cwd: ROOT },
    mcpServers: {
      specter: {
        command: PYTHON,
        args: [SPECTER_MCP_SCRIPT],
        env: { ...process.env } as Record<string, string>,
      },
    },
  });

  const escalationsPayload = escalations.map((e) => ({
    invoice_id: e.inv.id,
    vendor: e.inv.vendor,
    amount_gbp_pennies: e.inv.amount_gbp,
    description: e.inv.description,
    due_date: e.inv.due_date,
    vendor_metadata: e.inv.vendor_metadata,
    short_risk_reason: e.shortReason,
  }));

  const prompt = `You are the payments-risk reasoning agent for Signmaxxing.

You have an MCP server named **specter** attached. Use its \`lookup_vendor(vendor: string)\` tool to enrich vendor data. The tool returns JSON with: domain, incorporation_date, employee_count, risk_flags, source.

For each invoice in the JSON array below:
1. Call the specter \`lookup_vendor\` MCP tool with the exact vendor name.
2. Combine the Specter findings with the provided short_risk_reason.
3. Write 2-3 sentences (max 60 words) explaining the risk to a finance lead. Mention the vendor by name. Reference at least one concrete Specter fact when available. No bullets, no headers, plain English.

After processing every invoice, reply with **only** a JSON object — no other prose, no shell commands, no file writes — of this shape:

\`\`\`json
{ "reasons": { "<invoice_id>": "<reason text>" , ... } }
\`\`\`

Invoices:
\`\`\`json
${JSON.stringify(escalationsPayload, null, 2)}
\`\`\``;

  const run = await agent.send(prompt);
  let assistantText = "";
  const startedTools = new Set<string>();

  for await (const msg of run.stream() as AsyncIterable<SDKMessage>) {
    if (msg.type === "tool_call") {
      if (!startedTools.has(msg.call_id)) {
        startedTools.add(msg.call_id);
        await postTrace(`cursor-sdk: tool call → ${msg.name}`);
      }
      if (msg.status === "completed" || msg.status === "error") {
        await postTrace(
          `cursor-sdk: tool ${msg.name} ${msg.status}${
            msg.status === "error" ? "" : ""
          }`,
        );
      }
    } else if (msg.type === "thinking") {
      if (msg.text) {
        await postTrace(
          `cursor-sdk: thinking → ${truncate(msg.text.replace(/\s+/g, " "), 120)}`,
        );
      }
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          assistantText += block.text;
        }
      }
    } else if (msg.type === "status") {
      if (
        msg.status === "FINISHED" ||
        msg.status === "ERROR" ||
        msg.status === "CANCELLED"
      ) {
        await postTrace(`cursor-sdk: status ${msg.status}`);
      }
    }
  }

  try {
    agent.close();
  } catch {
    // best effort
  }

  await postTrace(
    `cursor-sdk: agent run ended (${assistantText.length} chars assistant text)`,
  );

  const json = extractJson(assistantText);
  if (json && typeof json === "object" && json !== null && "reasons" in json) {
    const obj = (json as { reasons: Record<string, string> }).reasons;
    for (const [id, text] of Object.entries(obj)) {
      reasons.set(id, String(text));
    }
  } else {
    await postTrace("cursor-sdk: could not parse JSON reasons, using fallbacks");
  }

  for (const e of escalations) {
    if (!reasons.has(e.inv.id)) {
      reasons.set(e.inv.id, fallbackReason(e));
    }
  }

  return reasons;
}

function extractJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function fallbackReason(e: Escalation): string {
  const amount = `£${(e.inv.amount_gbp / 100).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return `${e.inv.vendor} is requesting ${amount} for "${e.inv.description}". Risk signals: ${e.shortReason}. Verify the vendor's identity and the contract before approving.`;
}

async function main(): Promise<void> {
  await postTrace(
    `agent ${RUN_ID} starting against ${API} (cursor-sdk=${CURSOR_API_KEY ? "yes" : "no"})`,
  );

  const invoices = await getInvoices();
  await postTrace(`fetched ${invoices.length} unprocessed invoices`);
  if (invoices.length === 0) {
    await postTrace("nothing to do, exiting");
    return;
  }

  let autoPaid = 0;
  const escalations: Escalation[] = [];

  for (const inv of invoices) {
    const { confidence, reason } = await scoreInvoice(inv);
    if (confidence >= 0.85) {
      await autoPay(inv, confidence, reason);
      autoPaid++;
    } else {
      escalations.push({ inv, confidence, shortReason: reason });
    }
  }

  await postTrace(
    `score complete: ${autoPaid} auto-paid, ${escalations.length} pending Cursor SDK reasoning`,
  );

  const reasons = await reasonViaCursorSdk(escalations);

  for (const e of escalations) {
    const longReason = reasons.get(e.inv.id) ?? fallbackReason(e);
    await escalate(e.inv, e.confidence, longReason);
    await postTrace(
      `escalated ${e.inv.id} ${e.inv.vendor} c=${e.confidence.toFixed(2)}: ${truncate(longReason, 140)}`,
    );
  }

  await postTrace(
    `done: ${autoPaid} auto-paid, ${escalations.length} escalated (run ${RUN_ID})`,
  );
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exit(1);
});
