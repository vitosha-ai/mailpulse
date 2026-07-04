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
    const data = await call<Record<string, unknown>>("GET", `/email-accounts?page=${page}&limit=100`);
    // Accept the common wrapper shapes.
    const items = (data.emailAccounts ??
      data.data ??
      (data.payload as Record<string, unknown> | undefined)?.emailAccounts ??
      []) as Record<string, unknown>[];
    for (const raw of items) {
      const email = String(raw.fromEmail ?? raw.email ?? "").toLowerCase();
      if (!email.includes("@")) continue;
      all.push({
        id: String(raw.id ?? ""),
        email,
        status: raw.status != null ? String(raw.status) : null,
      });
    }
    const totalPages = Number(data.totalPages ?? 1);
    if (items.length < 100 || page >= totalPages) break;
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
export async function bulkReports(
  accounts: { id: string; email: string }[],
  startDate: string,
  endDate: string,
): Promise<TiDailyReport[]> {
  const emailById = new Map(accounts.map((a) => [a.id, a.email]));
  const out: TiDailyReport[] = [];

  for (let i = 0; i < accounts.length; i += 50) {
    const batch = accounts.slice(i, i + 50);
    const data = await call<unknown>("POST", "/reports/bulk", {
      emailAccountIds: batch.map((a) => a.id),
      startDate,
      endDate,
    });

    // Shape is only partially documented — walk the payload and collect
    // anything that looks like a per-day report row.
    const visit = (node: unknown, contextEmail: string | null) => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item, contextEmail);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;

      let email = contextEmail;
      const idRef = obj.emailAccountId ?? obj.accountId ?? obj.id;
      if (idRef != null && emailById.has(String(idRef))) email = emailById.get(String(idRef))!;
      const emailField = obj.fromEmail ?? obj.email;
      if (typeof emailField === "string" && emailField.includes("@")) email = emailField.toLowerCase();

      const date = obj.date ?? obj.day ?? obj.reportDate;
      if (email && typeof date === "string" && (obj.sent != null || obj.inbox != null)) {
        const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? "")) || 0);
        out.push({
          email,
          date: date.slice(0, 10),
          sent: num(obj.sent),
          inbox: num(obj.inbox),
          spam: num(obj.spam ?? obj.spamInbox),
          deliverabilityRate:
            obj.deliverabilityRate != null ? num(obj.deliverabilityRate) : null,
        });
      }
      for (const v of Object.values(obj)) visit(v, email);
    };
    visit(data, null);
    if (i + 50 < accounts.length) await new Promise((r) => setTimeout(r, PACE_MS));
  }
  return out;
}
