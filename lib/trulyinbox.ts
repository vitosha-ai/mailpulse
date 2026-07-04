import { getSetting } from "./db";

// TrulyInbox Open API client. Docs: https://developer.trulyinbox.com
// Auth: X-Api-Key header. Rate limit: 20 requests/minute — pace all loops.
const BASE = "https://lupus-edge.trulyinbox.com/v1";

export class TrulyInboxError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiKey(): string {
  const key = getSetting("trulyinbox_api_key");
  if (!key) throw new TrulyInboxError(0, "TrulyInbox API key not configured (Settings page).");
  return key;
}

const PACE_MS = 3500; // ~17 req/min, under the 20/min cap

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": apiKey(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 65_000)); // wait out the minute window
    return call<T>(method, path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TrulyInboxError(res.status, `TrulyInbox ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type TrulyInboxAccount = {
  id: string;
  email: string;
  status: string | null; // active | warming | paused | error | auth-expired
};

export async function listAllAccounts(): Promise<TrulyInboxAccount[]> {
  const all: TrulyInboxAccount[] = [];
  for (let page = 1; page < 100; page++) {
    // Live shape (verified July 2026): { payload: { items, total, page, totalPages } }
    const data = await call<{
      payload?: { items?: Record<string, unknown>[]; totalPages?: number };
    }>("GET", `/email-accounts?page=${page}&limit=100`);
    const items = data.payload?.items ?? [];
    for (const raw of items) {
      const email = String(raw.fromEmail ?? raw.email ?? "").toLowerCase();
      if (!email.includes("@")) continue;
      all.push({
        id: String(raw.id ?? ""),
        email,
        status: raw.status != null ? String(raw.status) : null,
      });
    }
    const totalPages = Number(data.payload?.totalPages ?? 1);
    if (items.length === 0 || page >= totalPages) break;
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
  return all;
}

export type TiDailyReport = {
  email: string;
  date: string;
  sent: number;
  inbox: number;
  spam: number;
  deliverabilityRate: number | null;
};

// Bulk daily reports, up to 50 accounts per call.
// Live shape (verified July 2026): body { emailAccountIds, from, to } →
// { payload: { reports: [{ emailAccountId, days: [{date, sent, inbox, spam,
//   bounced, deliverabilityRate, ...}] }] } }
export async function bulkReports(
  accounts: { id: string; email: string }[],
  from: string,
  to: string,
): Promise<TiDailyReport[]> {
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));
  const out: TiDailyReport[] = [];

  for (let i = 0; i < accounts.length; i += 50) {
    const batch = accounts.slice(i, i + 50);
    const data = await call<{
      payload?: {
        reports?: {
          emailAccountId: number | string;
          days?: Record<string, unknown>[];
        }[];
      };
    }>("POST", "/reports/bulk", {
      emailAccountIds: batch.map((a) => Number(a.id)),
      from,
      to,
    });

    const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "")) || 0);
    for (const report of data.payload?.reports ?? []) {
      const email = emailById.get(String(report.emailAccountId));
      if (!email) continue;
      for (const day of report.days ?? []) {
        if (typeof day.date !== "string") continue;
        out.push({
          email,
          date: day.date.slice(0, 10),
          sent: num(day.sent),
          inbox: num(day.inbox),
          spam: num(day.spam),
          deliverabilityRate: day.deliverabilityRate != null ? num(day.deliverabilityRate) : null,
        });
      }
    }
    if (i + 50 < accounts.length) await new Promise((r) => setTimeout(r, PACE_MS));
  }
  return out;
}
