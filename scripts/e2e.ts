// Full demo loop in one script: reset, agent, sign one approve + one reject,
// then dump the resulting ledger so we can confirm the demo path holds.

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const API = process.env.SIGNMAXXING_API ?? "http://127.0.0.1:8000";

async function jsonReq<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function main(): Promise<void> {
  console.log("→ reset demo");
  await jsonReq(`/agent/reset`, { method: "POST" });

  console.log("→ run agent stub");
  const run = await jsonReq<{ auto_paid: unknown[]; escalated: unknown[] }>(
    `/agent/run`,
    { method: "POST" },
  );
  console.log(
    `   auto-paid ${run.auto_paid.length}, escalated ${run.escalated.length}`,
  );
  if (run.escalated.length !== 3) {
    throw new Error(`expected 3 escalations, got ${run.escalated.length}`);
  }

  const kp = nacl.sign.keyPair();
  const pubkey = naclUtil.encodeBase64(kp.publicKey);
  await jsonReq(`/pubkey`, { method: "POST", body: JSON.stringify({ pubkey }) });

  const escalations = await jsonReq<
    { invoice: { id: string; vendor: string } }[]
  >(`/escalations`);
  if (escalations.length !== 3) {
    throw new Error(`expected 3 escalations on GET, got ${escalations.length}`);
  }

  async function sign(
    invoiceId: string,
    decision: "approve" | "reject",
  ): Promise<unknown> {
    const payload = {
      invoice_id: invoiceId,
      decision,
      timestamp: Date.now(),
      pubkey,
    };
    const sig = nacl.sign.detached(
      naclUtil.decodeUTF8(JSON.stringify(payload)),
      kp.secretKey,
    );
    return jsonReq(`/approve`, {
      method: "POST",
      body: JSON.stringify({ ...payload, signature: naclUtil.encodeBase64(sig) }),
    });
  }

  console.log("→ approve INV-0048 (Acme)");
  console.log("   ", await sign("INV-0048", "approve"));
  console.log("→ reject  INV-0050 (QuickPay)");
  console.log("   ", await sign("INV-0050", "reject"));

  console.log("→ verify bad-sig is 401");
  const r = await fetch(`${API}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invoice_id: "INV-0049",
      decision: "approve",
      timestamp: Date.now(),
      pubkey,
      signature: naclUtil.encodeBase64(new Uint8Array(64)),
    }),
  });
  console.log(`   bad-sig HTTP ${r.status} (should be 401)`);
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);

  const ledger = await jsonReq<
    { decision: string; vendor: string; amount_gbp: number }[]
  >(`/ledger`);
  const auto = ledger.filter((l) => l.decision === "auto_pay").length;
  const approved = ledger.filter((l) => l.decision === "approve").length;
  const rejected = ledger.filter((l) => l.decision === "reject").length;
  console.log(
    `→ ledger: ${auto} auto-paid, ${approved} approved, ${rejected} rejected`,
  );
  if (auto !== 47 || approved !== 1 || rejected !== 1) {
    throw new Error("ledger shape unexpected");
  }
  console.log("✓ end-to-end demo holds");
}

main().catch((err) => {
  console.error("✗ demo broken:", err);
  process.exit(1);
});
