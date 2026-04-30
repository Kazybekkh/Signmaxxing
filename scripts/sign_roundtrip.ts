// Smoke test: registers a fresh keypair, fetches escalations, signs an
// approval, and posts to /approve. Mirrors what the XR client does.

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const API = process.env.SIGNMAXXING_API ?? "http://127.0.0.1:8000";

async function main(): Promise<void> {
  const kp = nacl.sign.keyPair();
  const pubkey = naclUtil.encodeBase64(kp.publicKey);

  let resp = await fetch(`${API}/pubkey`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pubkey }),
  });
  if (!resp.ok) throw new Error(`pubkey register HTTP ${resp.status}`);
  console.log(`registered pubkey ${pubkey.slice(0, 18)}…`);

  resp = await fetch(`${API}/escalations`);
  const escalations = (await resp.json()) as { invoice: { id: string; vendor: string } }[];
  if (escalations.length === 0) {
    console.log("no escalations to approve, exiting");
    return;
  }

  const target = escalations[0]!;
  const payload = {
    invoice_id: target.invoice.id,
    decision: "approve" as const,
    timestamp: Date.now(),
    pubkey,
  };
  const sig = nacl.sign.detached(
    naclUtil.decodeUTF8(JSON.stringify(payload)),
    kp.secretKey,
  );
  const body = { ...payload, signature: naclUtil.encodeBase64(sig) };

  resp = await fetch(`${API}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  console.log(`approve ${target.invoice.id} ${target.invoice.vendor} ->`, result);
  if (!resp.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
