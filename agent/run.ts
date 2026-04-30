// Cursor SDK agent entrypoint.
//
// Reads /invoices, scores each, auto-pays the safe ones via /auto_pay,
// posts the rest to /escalations. Emits a trace to /agent/trace so the HUD
// can show what happened.
//
// Hard cap: one pass over invoices. No retries, no loops.
//
// We try to load `@cursor/sdk` for richer tracing if it is available, but
// fall back to plain fetch + console so the build keeps working without it.

import type { Invoice } from "../shared/types.ts";
import { scoreInvoice } from "./score.ts";
import { explainEscalation } from "./reason.ts";

const API = process.env.SIGNMAXXING_API ?? "http://127.0.0.1:8000";
const RUN_ID = `run-${Date.now()}`;

type CursorTrace = (line: string) => void;
async function loadCursorTrace(): Promise<CursorTrace> {
  try {
    // Optional integration: only used if the workspace ever installs the SDK.
    // We avoid a hard import so missing modules do not fail the build.
    const mod: any = await import(/* @vite-ignore */ "@cursor/sdk").catch(
      () => null,
    );
    if (mod && typeof mod.trace === "function") {
      return (line: string) => mod.trace({ runId: RUN_ID, line });
    }
  } catch {
    // ignore
  }
  return () => {};
}

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
  if (!resp.ok) {
    throw new Error(`failed to fetch invoices: HTTP ${resp.status}`);
  }
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
    body: JSON.stringify({
      invoice_id: inv.id,
      confidence,
      reason,
    }),
  });
  if (!resp.ok) {
    throw new Error(`auto_pay failed for ${inv.id}: HTTP ${resp.status}`);
  }
}

async function escalate(
  inv: Invoice,
  confidence: number,
  reason: string,
): Promise<void> {
  const resp = await fetch(`${API}/escalations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invoice_id: inv.id,
      confidence,
      reason,
    }),
  });
  if (!resp.ok) {
    throw new Error(`escalation failed for ${inv.id}: HTTP ${resp.status}`);
  }
}

async function main(): Promise<void> {
  const cursorTrace = await loadCursorTrace();

  await postTrace(`agent ${RUN_ID} starting against ${API}`);
  cursorTrace(`agent ${RUN_ID} starting`);

  const invoices = await getInvoices();
  await postTrace(`fetched ${invoices.length} unprocessed invoices`);
  if (invoices.length === 0) {
    await postTrace("nothing to do, exiting");
    return;
  }

  let autoPaid = 0;
  let escalated = 0;
  const escalations: { inv: Invoice; confidence: number; reason: string }[] = [];

  for (const inv of invoices) {
    const { confidence, reason } = await scoreInvoice(inv);
    if (confidence >= 0.85) {
      await autoPay(inv, confidence, reason);
      autoPaid++;
      cursorTrace(`auto-pay ${inv.id} ${inv.vendor} c=${confidence.toFixed(2)}`);
    } else {
      escalations.push({ inv, confidence, reason });
      escalated++;
    }
  }

  await postTrace(
    `score complete: ${autoPaid} auto-paid, ${escalated} pending reasoning`,
  );

  for (const e of escalations) {
    const longReason = await explainEscalation(e.inv, e.reason);
    await escalate(e.inv, e.confidence, longReason);
    await postTrace(
      `escalated ${e.inv.id} ${e.inv.vendor} c=${e.confidence.toFixed(2)}: ${longReason}`,
    );
    cursorTrace(`escalated ${e.inv.id}`);
  }

  await postTrace(
    `done: ${autoPaid} auto-paid, ${escalated} escalated (run ${RUN_ID})`,
  );
}

main().catch((err) => {
  console.error("agent failed:", err);
  process.exit(1);
});
