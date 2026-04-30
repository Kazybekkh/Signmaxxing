// tweetnacl wrapper for browser-side Ed25519.
//
// Keypair persists in localStorage so refreshes do not invalidate the
// pubkey already registered with the backend.

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import type { SignedApproval } from "../../shared/types";

const STORAGE_KEY = "signmaxxing.keypair.v1";

export type Keypair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
};

export function loadOrCreateKeypair(): Keypair {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as { pk: string; sk: string };
      return {
        publicKey: naclUtil.decodeBase64(parsed.pk),
        secretKey: naclUtil.decodeBase64(parsed.sk),
        publicKeyB64: parsed.pk,
      };
    } catch {
      // fall through and regenerate
    }
  }
  const kp = nacl.sign.keyPair();
  const pk = naclUtil.encodeBase64(kp.publicKey);
  const sk = naclUtil.encodeBase64(kp.secretKey);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ pk, sk }));
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    publicKeyB64: pk,
  };
}

export function signApproval(
  kp: Keypair,
  invoiceId: string,
  decision: "approve" | "reject",
): SignedApproval {
  const payload = {
    invoice_id: invoiceId,
    decision,
    timestamp: Date.now(),
    pubkey: kp.publicKeyB64,
  };
  // Must match the server's canonical form exactly: keys in this order,
  // no whitespace.
  const message = JSON.stringify(payload);
  const sig = nacl.sign.detached(naclUtil.decodeUTF8(message), kp.secretKey);
  return {
    ...payload,
    signature: naclUtil.encodeBase64(sig),
  };
}
