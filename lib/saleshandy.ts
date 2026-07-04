import { getSetting } from "./db";

// Saleshandy Open API client. Docs: https://developer.saleshandy.com
// Auth: x-api-key header (Settings → API in Saleshandy; needs Pro plan+).
const BASE = "https://open-api.saleshandy.com/v1";

export class SaleshandyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiKey(): string {
  const key = getSetting("saleshandy_api_key");
  if (!key) throw new SaleshandyError(0, "Saleshandy API key not configured (Settings page).");
  return key;
}

async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Rate limits are undocumented ("fair usage") — back off generously on 429.
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return call<T>(method, path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SaleshandyError(res.status, `Saleshandy ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type SaleshandyAccount = {
  id: string | number;
  email: string;
  status?: string;
  healthScore?: number;
  esp?: string;
  [key: string]: unknown;
};

export async function listAllEmailAccounts(): Promise<SaleshandyAccount[]> {
  const all: SaleshandyAccount[] = [];
  for (let page = 1; page < 100; page++) {
    const data = await call<{ payload?: { emailAccounts?: SaleshandyAccount[] } }>(
      "POST",
      "/email-accounts",
      { page, pageSize: 100 },
    );
    // Response shapes vary across Saleshandy endpoints; accept both wrappers.
    const items =
      data.payload?.emailAccounts ??
      (data as unknown as { emailAccounts?: SaleshandyAccount[] }).emailAccounts ??
      [];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

export type SaleshandyAccountStats = {
  setupScore?: number;
  inboxScore?: number;
  bounceRate?: number;
  totalSent?: number;
  [key: string]: unknown;
};

export async function emailAccountStats(emailId: string | number): Promise<SaleshandyAccountStats> {
  const data = await call<{ payload?: SaleshandyAccountStats }>(
    "POST",
    "/analytics/emailaccount/stats",
    { emailId },
  );
  return data.payload ?? (data as unknown as SaleshandyAccountStats);
}
