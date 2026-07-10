import { NextResponse } from "next/server";
import { getSetting } from "@/lib/db";

// TEMPORARY: broad sweep for any Maildoso endpoint exposing the IMAP host.
export async function GET() {
  const token = getSetting("maildoso_api_key");
  if (!token) return NextResponse.json({ error: "no maildoso_api_key stored" });
  const base = "https://api.maildoso.com/v1";
  const auth = { Authorization: `Bearer ${token}` };

  let mailboxId: number | null = null;
  try {
    const r = await fetch(`${base}/user/forwarding-lookup?offset=0&limit=50`, { headers: auth });
    const j = await r.json();
    mailboxId = (j.items ?? [])[0]?.attached_mailboxes?.[0]?.id ?? null;
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

  const urls = [
    `${base}/user/accounts-lookup?ids=${mailboxId}`,
    `${base}/user/accounts-lookup?account_ids=${mailboxId}`,
    `${base}/user/accounts-lookup?id=${mailboxId}`,
    `${base}/user/accounts-export`,
    `${base}/user/accounts/export`,
    `${base}/user/sequencers`,
    `${base}/user/domains`,
    `${base}/user/domains-lookup?offset=0&limit=50`,
  ];

  const results: Record<string, unknown>[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: auth });
      const text = await res.text();
      let shape: unknown = text.slice(0, 400);
      if (res.ok) {
        try {
          shape = redact(JSON.parse(text));
        } catch {}
      }
      // Flag if the response mentions imap anywhere.
      const hasImap = /imap/i.test(text);
      results.push({ url: url.replace(base, ""), status: res.status, hasImap, shape });
    } catch (e) {
      results.push({ url: url.replace(base, ""), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ mailboxId, results });
}
