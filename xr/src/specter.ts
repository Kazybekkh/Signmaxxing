// Specter MCP enrichment with mock fallback.
//
// In a real demo we would call the Specter MCP server using the URL +
// key from Francisco. We never received those, so this module hits
// `/api/specter/:vendor` if available and otherwise serves canned data
// keyed by vendor name. Either way it caches results.

import type { SpecterData } from "../../shared/types";

const cache = new Map<string, SpecterData>();

const CANNED: Record<string, SpecterData> = {
  "Acme Holdings Ltd": {
    vendor: "Acme Holdings Ltd",
    domain: "acme-holdings.co",
    incorporation_date: "2026-04-25",
    employee_count: 1,
    risk_flags: [
      "Incorporated 5 days ago",
      "Director shares address with 12 other shell entities",
      "No filed accounts",
    ],
    source: "mock",
  },
  "Nexus Global Trading": {
    vendor: "Nexus Global Trading",
    domain: undefined,
    incorporation_date: "2024-11-02",
    employee_count: 3,
    risk_flags: [
      "No public website on file",
      "Free-zone registration in Dubai",
      "Sanctions-list adjacent counterparties",
    ],
    source: "mock",
  },
  "QuickPay Solutions": {
    vendor: "QuickPay Solutions",
    domain: "quickpay-solutions.tk",
    incorporation_date: "2025-09-12",
    employee_count: 0,
    risk_flags: [
      "Domain on .tk free TLD",
      "Seychelles incorporation, opaque ownership",
      "Bank account opened 11 days ago",
    ],
    source: "mock",
  },
};

function fallbackFor(vendor: string): SpecterData {
  return (
    CANNED[vendor] ?? {
      vendor,
      risk_flags: ["No Specter record found"],
      source: "mock",
    }
  );
}

export async function enrich(vendor: string): Promise<SpecterData> {
  const cached = cache.get(vendor);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `/api/specter/${encodeURIComponent(vendor)}`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (resp.ok) {
      const data = (await resp.json()) as SpecterData;
      cache.set(vendor, data);
      return data;
    }
  } catch {
    // ignore, fall back to canned data
  }
  const data = fallbackFor(vendor);
  cache.set(vendor, data);
  return data;
}
