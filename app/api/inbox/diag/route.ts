import { NextResponse } from "next/server";
import { getSetting } from "@/lib/db";

// TEMPORARY: find the IMAP host by probing Maildoso's sequencer-export /
// per-account endpoints (those hand out IMAP host/port for tool connections).
export async function GET() {
  const token = getSetting("maildoso_api_key");
  if (!token) return NextResponse.json({ error: "no maildoso_api_key stored" });
  const base = "https://api.maildoso.com/v1";
  const auth = { Authorization: `Bearer ${token}` };

  // A known attached mailbox id from forwarding-lookup.
  let mailboxId: number | null = null;
  let mailboxEmail = "";
  try {
    const r = await fetch(`${base}/user/forwarding-lookup?offset=0&limit=50`, { headers: auth });
    const j = await r.json();
    const mb = (j.items ?? [])[0]?.attached_mailboxes?.[0];
    mailboxId = mb?.id ?? null;
    mailboxEmail = mb?.email_account ?? "";
  } catch {}

  const redact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, 2).map(redact);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/pass|secret|token/i.test(k)) o[k] = "«redacted»";
        else o[k] = typeof val === "object" ? redact(val) : val;
      }
      return o;
    }
    return v;
  };

  const attempts: { label: string; method: string; url: string; body?: unknown }[] = [
    { label: "sequencers-export GET", method: "GET", url: `${base}/user/sequencers/export` },
    { label: "sequencers-export POST all", method: "POST", url: `${base}/user/sequencers/export`, body: { account_ids: mailboxId ? [mailboxId] : [] } },
    { label: "sequencers-export POST emails", method: "POST", url: `${base}/user/sequencers/export`, body: mailboxEmail ? [mailboxEmail] : [] },
    { label: "sequencers-export POST bare-list", method: "POST", url: `${base}/user/sequencers/export`, body: mailboxId ? [mailboxId] : [] },
    { label: "account detail", method: "GET", url: mailboxId ? `${base}/user/accounts/${mailboxId}` : `${base}/user/accounts` },
    { label: "accounts POST list", method: "POST", url: `${base}/user/accounts`, body: mailboxId ? [mailboxId] : [] },
  ];

  const results: Record<string, unknown>[] = [];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        method: a.method,
        headers: { ...auth, ...(a.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
      });
      const text = await res.text();
      let shape: unknown = text.slice(0, 400);
      if (res.ok) {
        try {
          shape = redact(JSON.parse(text));
        } catch {}
      }
      results.push({ label: a.label, status: res.status, shape });
    } catch (e) {
      results.push({ label: a.label, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ mailboxId, mailboxEmail, results });
}
