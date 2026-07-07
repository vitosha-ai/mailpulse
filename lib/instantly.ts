import { getSetting } from "./db";

// Instantly API v2 client. Docs: https://developer.instantly.ai
// Auth: Bearer token (Settings → Integrations → API keys in Instantly).
const BASE = "https://api.instantly.ai/api/v2";

export class InstantlyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiKey(): string {
  const key = getSetting("instantly_api_key");
  if (!key) throw new InstantlyError(0, "Instantly API key not configured (Settings page).");
  return key;
}

async function call<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return call<T>(method, path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new InstantlyError(res.status, `Instantly ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type InstantlyAccount = {
  email: string;
  status: number; // 1 active, 2 paused, 3 maintenance, -1 connection error, -2 soft bounce, -3 sending error
  warmup_status: number; // 1 active, 0 paused, -1 banned, -2 spam folder unknown, -3 permanent suspension
  stat_warmup_score: number | null;
  provider_code: number; // 1 IMAP/SMTP, 2 Google, 3 Microsoft, 4 AWS
  daily_limit: number | null;
};

export async function listAllAccounts(): Promise<InstantlyAccount[]> {
  const all: InstantlyAccount[] = [];
  let startingAfter: string | undefined;
  // Cursor pagination, 100 per page; hard stop well above the expected ~900.
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const data = await call<{ items: InstantlyAccount[]; next_starting_after?: string }>(
      "GET",
      `/accounts?${qs}`,
    );
    all.push(...(data.items ?? []));
    if (!data.next_starting_after || (data.items ?? []).length === 0) break;
    startingAfter = data.next_starting_after;
  }
  return all;
}

export type WarmupAnalytics = {
  email_date_data: Record<
    string, // email
    Record<string, { sent?: number; landed_inbox?: number; landed_spam?: number; received?: number }>
  >;
  aggregate_data: Record<
    string,
    {
      sent?: number;
      landed_inbox?: number;
      landed_spam?: number;
      received?: number;
      health_score?: number;
      health_score_label?: string;
    }
  >;
};

// Max 100 emails per request — callers batch.
export async function warmupAnalytics(emails: string[]): Promise<WarmupAnalytics> {
  return call<WarmupAnalytics>("POST", "/accounts/warmup-analytics", { emails });
}

export async function pauseAccount(email: string) {
  return call("POST", `/accounts/${encodeURIComponent(email)}/pause`);
}

export async function resumeAccount(email: string) {
  return call("POST", `/accounts/${encodeURIComponent(email)}/resume`);
}

export async function updateDailyLimit(email: string, dailyLimit: number) {
  return call("PATCH", `/accounts/${encodeURIComponent(email)}`, { daily_limit: dailyLimit });
}

export async function enableWarmup(emails: string[]) {
  return call("POST", "/accounts/warmup/enable", { emails });
}

export async function disableWarmup(emails: string[]) {
  return call("POST", "/accounts/warmup/disable", { emails });
}

// ---- Inbox placement tests (requires the Inbox Placement add-on plan) ----

export async function createPlacementTest(name: string, emails: string[]) {
  // Schema verified live 2026-07-07: type 1 = one-time test (the app
  // schedules its own recurring batches, so the cheaper add-on tier
  // suffices); sending_method 1 + delivery_mode 1 = send from connected
  // accounts. Subject/body are what the seed inboxes receive — kept plain
  // and business-like on purpose.
  return call<{ id: string; recipients?: string[] }>("POST", "/inbox-placement-tests", {
    name,
    type: 1,
    sending_method: 1,
    delivery_mode: 1,
    run_immediately: true,
    // Judge at BOTH providers (options from GET .../email-service-provider-options).
    recipients_labels: [
      { region: "North America", sub_region: "US", type: "Professional", esp: "Google" },
      { region: "North America", sub_region: "US", type: "Professional", esp: "Outlook" },
    ],
    email_subject: "Quick question about next week's schedule",
    email_body:
      "Hi,\n\nJust checking whether Tuesday or Wednesday works better on your side for a short call next week. Either afternoon is fine for us.\n\nBest regards,\nOperations Team",
    emails,
  });
}

export async function getPlacementTest(id: string) {
  return call<Record<string, unknown>>("GET", `/inbox-placement-tests/${id}`);
}

export async function getPlacementAnalytics(testId: string) {
  // Live-verified: endpoint expects test_ids as an array.
  return call<Record<string, unknown>>("POST", "/inbox-placement-analytics/stats-by-test-id", {
    test_ids: [testId],
  });
}

export type PlacementRecord = {
  sender_email: string;
  recipient_email: string;
  is_spam: boolean;
  spf_pass: boolean | null;
  dkim_pass: boolean | null;
  dmarc_pass: boolean | null;
};

// One row per sender→seed judgment (live-verified shape, July 2026).
export async function listPlacementRecords(testId: string): Promise<PlacementRecord[]> {
  const all: PlacementRecord[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ test_id: testId, limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const data = await call<{ items: PlacementRecord[]; next_starting_after?: string }>(
      "GET",
      `/inbox-placement-analytics?${qs}`,
    );
    all.push(...(data.items ?? []));
    if (!data.next_starting_after || (data.items ?? []).length === 0) break;
    startingAfter = data.next_starting_after;
  }
  return all;
}
