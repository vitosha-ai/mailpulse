import { NextResponse } from "next/server";
import { getSetting } from "@/lib/db";

// TEMPORARY diagnostic: probes Maildoso API bases/paths with the stored token
// and reports status + response shape (values redacted) so we can wire the
// exact endpoint. Remove after the inbox connection is confirmed.
export async function GET() {
  const token = getSetting("maildoso_api_key");
  if (!token) return NextResponse.json({ error: "no maildoso_api_key stored" });

  const bases = [
    "https://api.maildoso.com/v1",
    "https://app.maildoso.com/api/v1",
    "https://api.maildoso.com",
    "https://app.maildoso.com/api",
  ];
  const paths = [
    "/user/forwarding-lookup",
    "/user/accounts/forwarding",
    "/user/accounts-lookup",
    "/user/accounts",
    "/user/me",
  ];

  const redact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, 1).map(redact);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/pass|token|secret/i.test(k)) o[k] = "«redacted»";
        else if (typeof val === "object") o[k] = redact(val);
        else o[k] = val;
      }
      return o;
    }
    return v;
  };

  void bases;
  void paths;
  const base = "https://api.maildoso.com/v1";
  const auth = { Authorization: `Bearer ${token}` };
  const attempts: { label: string; method: string; url: string; body?: unknown }[] = [
    { label: "accounts-lookup GET +params", method: "GET", url: `${base}/user/accounts-lookup?offset=0&limit=50` },
    { label: "accounts-lookup GET limit", method: "GET", url: `${base}/user/accounts-lookup?limit=50` },
    { label: "accounts-lookup POST", method: "POST", url: `${base}/user/accounts-lookup`, body: { offset: 0, limit: 50 } },
    { label: "accounts POST", method: "POST", url: `${base}/user/accounts`, body: { offset: 0, limit: 50 } },
    { label: "forwarding-lookup GET", method: "GET", url: `${base}/user/forwarding-lookup?offset=0&limit=50` },
  ];

  const results: Record<string, unknown>[] = [];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, {
        method: a.method,
        headers: { ...auth, ...(a.body ? { "Content-Type": "application/json" } : {}) },
        body: a.body ? JSON.stringify(a.body) : undefined,
      });
      const text = await res.text();
      let shape: unknown = text.slice(0, 300);
      if (res.ok) {
        try {
          // Keep imap host/port visible; only redact secrets.
          shape = redact(JSON.parse(text));
        } catch {
          /* keep text */
        }
      }
      results.push({ label: a.label, status: res.status, shape });
    } catch (e) {
      results.push({ label: a.label, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results });
}
