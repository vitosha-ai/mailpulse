import { getSetting } from "./db";

// Smartlead API client. Docs: https://api.smartlead.ai
// Auth: api_key query parameter. Rate limit is tight (~10 req / 2 s) — we
// only make a handful of paged list calls, well within it.
const BASE = "https://server.smartlead.ai/api/v1";

export class SmartleadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiKey(): string {
  const key = getSetting("smartlead_api_key");
  if (!key) throw new SmartleadError(0, "Smartlead API key not configured (Settings page).");
  return key;
}

async function call<T>(
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  attempt = 0,
): Promise<T> {
  const qs = new URLSearchParams({ ...params, api_key: apiKey() });
  const method = body === undefined ? "GET" : "POST";
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
    return call<T>(path, params, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SmartleadError(res.status, `Smartlead ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// Sets the campaign sending limit. 0 = effectively paused (verified live:
// this is how the Spamhaus-domain senders were stopped).
export async function setMaxEmailsPerDay(accountId: string, maxPerDay: number) {
  return call(`/email-accounts/${accountId}`, {}, { max_email_per_day: maxPerDay });
}

export type SmartleadAccount = {
  id: string | number;
  email: string;
  status: string | null;
  messagePerDay: number | null;
  warmupStatus: string | null;
  warmupReputation: number | null; // 0-100
  smtpOk: boolean | null;
  imapOk: boolean | null;
};

// Response shapes vary between Smartlead docs versions — normalize tolerantly.
function normalize(raw: Record<string, unknown>): SmartleadAccount | null {
  const email = String(raw.from_email ?? raw.email ?? "").toLowerCase();
  if (!email.includes("@")) return null;
  const warmup = (raw.warmup_details ?? {}) as Record<string, unknown>;
  const repRaw = warmup.warmup_reputation ?? raw.warmup_reputation;
  // Reputation may arrive as "98%" or 98.
  const rep =
    typeof repRaw === "number" ? repRaw : parseFloat(String(repRaw ?? "").replace("%", "")) || null;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v == null ? null : !!v);
  return {
    id: (raw.id ?? raw.email_account_id ?? "") as string | number,
    email,
    status: raw.status != null ? String(raw.status) : null,
    messagePerDay:
      typeof raw.message_per_day === "number" ? raw.message_per_day : null,
    warmupStatus: warmup.status != null ? String(warmup.status) : null,
    warmupReputation: rep,
    smtpOk: bool(raw.is_smtp_success ?? raw.smtp_success),
    imapOk: bool(raw.is_imap_success ?? raw.imap_success),
  };
}

export async function listAllAccounts(): Promise<SmartleadAccount[]> {
  const all: SmartleadAccount[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const data = await call<unknown>("/email-accounts/", {
      offset: String(offset),
      limit: "100",
    });
    const items = Array.isArray(data)
      ? data
      : ((data as Record<string, unknown>).email_accounts ??
          (data as Record<string, unknown>).data ??
          []);
    const list = (items as Record<string, unknown>[]).map(normalize).filter(Boolean) as SmartleadAccount[];
    all.push(...list);
    if (list.length < 100) break;
    // Stay under Smartlead's ~10 req / 2 s limit.
    await new Promise((r) => setTimeout(r, 300));
  }
  return all;
}
