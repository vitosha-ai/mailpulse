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

  const results: Record<string, unknown>[] = [];
  for (const base of bases) {
    for (const path of paths) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        let shape: unknown = text.slice(0, 200);
        if (res.ok) {
          try {
            shape = redact(JSON.parse(text));
          } catch {
            /* keep text */
          }
        }
        results.push({ url: `${base}${path}`, status: res.status, shape });
      } catch (e) {
        results.push({ url: `${base}${path}`, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return NextResponse.json({ results });
}
