// Backend client. Uses /api/* via the Vite proxy so this works on the
// laptop and on the headset over the same origin.

import type { Card, LedgerEntry, SignedApproval } from "../../shared/types";

const BASE =
  (import.meta as any).env?.VITE_API_BASE ?? "/api";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${path} -> ${resp.status} ${text}`);
  }
  return (await resp.json()) as T;
}

export async function fetchEscalations(): Promise<Card[]> {
  return jsonFetch<Card[]>(`/escalations`);
}

export async function registerPubkey(pubkey: string): Promise<void> {
  await jsonFetch<{ status: string }>(`/pubkey`, {
    method: "POST",
    body: JSON.stringify({ pubkey }),
  });
}

export async function postApproval(
  body: SignedApproval,
): Promise<{ status: string }> {
  return jsonFetch<{ status: string }>(`/approve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function fetchLedger(): Promise<LedgerEntry[]> {
  return jsonFetch<LedgerEntry[]>(`/ledger`);
}

export async function fetchTrace(
  limit = 50,
): Promise<{ id: number; line: string; timestamp: number }[]> {
  return jsonFetch(`/agent/trace?limit=${limit}`);
}

export async function runAgentStub(): Promise<{
  auto_paid: unknown[];
  escalated: unknown[];
}> {
  return jsonFetch(`/agent/run`, { method: "POST" });
}

export async function resetDemo(): Promise<void> {
  await jsonFetch(`/agent/reset`, { method: "POST" });
}
