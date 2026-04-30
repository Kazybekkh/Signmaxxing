// Shared types between agent (TypeScript), XR client, and backend (mirrored in Python)
// Money convention: amount_gbp is integer pennies. Display by dividing by 100.

export type Invoice = {
  id: string;
  vendor: string;
  amount_gbp: number; // integer pennies
  description: string;
  due_date: string; // ISO date
  vendor_metadata: {
    domain?: string;
    incorporated?: string; // ISO date
    country?: string;
  };
};

export type SpecterData = {
  vendor: string;
  domain?: string;
  incorporation_date?: string;
  employee_count?: number;
  risk_flags: string[];
  source: "specter" | "mock";
};

export type Card = {
  invoice: Invoice;
  confidence: number; // 0..1
  reason: string;
  enrichment?: SpecterData;
};

export type SignedApproval = {
  invoice_id: string;
  decision: "approve" | "reject";
  timestamp: number; // unix ms
  pubkey: string; // base64
  signature: string; // base64, signs JSON.stringify of the 4 fields above (excluding signature itself)
};

export type LedgerEntry = {
  id: number;
  invoice_id: string;
  vendor: string;
  amount_gbp: number;
  decision: "auto_pay" | "approve" | "reject";
  timestamp: number;
  trace?: string;
};

export type AgentRunResult = {
  auto_paid: Invoice[];
  escalated: Card[];
  trace: string[];
};
