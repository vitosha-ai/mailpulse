import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Read-only: per-domain placement verdict, for the mailbox-allocator (a
// separate local repo) to consult before assigning new campaigns to a box.
// Placement is tested per-domain (one mailbox represents the whole domain's
// reputation — see lib/placement.ts), so this rolls each sender's LATEST
// result up to its domain and reports the worst verdict seen there within
// the lookback window. A domain with no result in the window is simply
// absent from the response — the caller decides how to treat "no data".
//
// ?days=N (default 30) sets the lookback window.

export async function GET(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = Number(request.nextUrl.searchParams.get("days") || "30") || 30;
  const db = getDb();

  // Latest placement_results row per sender email, within the window.
  const rows = db
    .prepare(
      `SELECT s.domain AS domain, pr.email, pr.google_verdict, pr.microsoft_verdict, pr.inbox_rate, pr.tested_at
       FROM placement_results pr
       JOIN senders s ON s.email = pr.email
       WHERE pr.tested_at >= datetime('now', ?)
         AND pr.id IN (
           SELECT MAX(id) FROM placement_results GROUP BY email
         )`,
    )
    .all(`-${days} days`) as {
    domain: string;
    email: string;
    google_verdict: string | null;
    microsoft_verdict: string | null;
    inbox_rate: number | null;
    tested_at: string;
  }[];

  const byDomain = new Map<string, { domain: string; worstVerdict: "spam" | "inbox"; anyGoogleSpam: boolean; anyMicrosoftSpam: boolean; minInboxRate: number | null; latestTestedAt: string; testedSenders: string[] }>();

  for (const r of rows) {
    const cur = byDomain.get(r.domain) ?? {
      domain: r.domain,
      worstVerdict: "inbox" as const,
      anyGoogleSpam: false,
      anyMicrosoftSpam: false,
      minInboxRate: null,
      latestTestedAt: r.tested_at,
      testedSenders: [],
    };
    if (r.google_verdict === "spam") cur.anyGoogleSpam = true;
    if (r.microsoft_verdict === "spam") cur.anyMicrosoftSpam = true;
    if (cur.anyGoogleSpam || cur.anyMicrosoftSpam) cur.worstVerdict = "spam";
    if (r.inbox_rate != null && (cur.minInboxRate == null || r.inbox_rate < cur.minInboxRate)) cur.minInboxRate = r.inbox_rate;
    if (r.tested_at > cur.latestTestedAt) cur.latestTestedAt = r.tested_at;
    cur.testedSenders.push(r.email);
    byDomain.set(r.domain, cur);
  }

  return NextResponse.json({ ok: true, days, domains: Array.from(byDomain.values()) });
}
