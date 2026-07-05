import { getSetting } from "./db";

// Saleshandy Open API client. Docs: https://developer.saleshandy.com
// Auth: x-api-key header (Settings → API in Saleshandy; needs Pro plan+).
// NOTE: response shapes below were verified against the live API (July 2026)
// and differ from the docs: list lives at payload.emails with fromEmail,
// stats live at payload["Email Analytics"] with human-labeled keys.
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
  id: string;
  email: string;
  status: number | null; // 1 = active (observed)
  esp: string | null; // e.g. "o365", "gmail"
  dailyLimit: number | null;
  usedToday: number | null; // dailyLimit - available-quota
};

type RawAccount = {
  id: string | number;
  fromEmail?: string;
  email?: string;
  status?: number;
  emailServiceProvider?: string;
  settings?: { code: string; value: string }[];
};

export async function listAllEmailAccounts(): Promise<SaleshandyAccount[]> {
  const all: SaleshandyAccount[] = [];
  for (let page = 1; page < 100; page++) {
    const data = await call<{ payload?: { emails?: RawAccount[] } }>("POST", "/email-accounts", {
      page,
      pageSize: 100,
    });
    const items = data.payload?.emails ?? [];
    for (const raw of items) {
      const email = String(raw.fromEmail ?? raw.email ?? "").toLowerCase();
      if (!email.includes("@")) continue;
      const setting = (code: string) => {
        const s = raw.settings?.find((x) => x.code === code);
        return s ? parseInt(s.value, 10) : NaN;
      };
      const limit = setting("daily-sending-limit");
      const available = setting("available-quota");
      all.push({
        id: String(raw.id),
        email,
        status: typeof raw.status === "number" ? raw.status : null,
        esp: raw.emailServiceProvider ?? null,
        dailyLimit: Number.isNaN(limit) ? null : limit,
        usedToday:
          Number.isNaN(limit) || Number.isNaN(available) ? null : Math.max(0, limit - available),
      });
    }
    if (items.length < 100) break;
  }
  return all;
}

export type SaleshandyAccountStats = {
  setupScore: number | null;
  inboxScore: number | null;
  bounceRate: number | null;
  totalSent: number | null;
};

export async function emailAccountStats(emailId: string): Promise<SaleshandyAccountStats> {
  const data = await call<{ payload?: { "Email Analytics"?: Record<string, unknown>[] } }>(
    "POST",
    "/analytics/emailaccount/stats",
    { emailId },
  );
  const row = data.payload?.["Email Analytics"]?.[0] ?? {};
  const num = (v: unknown): number | null => {
    if (typeof v === "number") return v;
    const n = parseFloat(String(v ?? ""));
    return Number.isNaN(n) ? null : n;
  };
  return {
    setupScore: num(row["Setup Score"]),
    inboxScore: num(row["Inbox Score"]),
    bounceRate: num(row["Bounce Rate"]),
    totalSent: num(row["Total Sent"]),
  };
}

// Map Saleshandy's ESP names onto MailPulse provider buckets.
export function providerFromEsp(esp: string | null): string | null {
  if (!esp) return null;
  const e = esp.toLowerCase();
  if (e.includes("o365") || e.includes("outlook") || e.includes("microsoft")) return "microsoft";
  if (e.includes("gmail") || e.includes("google") || e.includes("gsuite")) return "google";
  return null;
}
