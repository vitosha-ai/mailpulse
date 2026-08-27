import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Read-only diagnostic: summarizes the most recent completed placement test's
// per-sender inbox rate, plus a Google/Microsoft breakdown. Same bearer-token
// auth pattern as the other admin diagnostics.

export async function GET(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const latest = db
    .prepare("SELECT id, name, emails, created_at, completed_at FROM placement_tests WHERE status = 'done' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; name: string; emails: string; created_at: string; completed_at: string } | undefined;

  if (!latest) return NextResponse.json({ ok: true, message: "no completed placement tests" });

  const results = db
    .prepare(
      `SELECT email, google_verdict, microsoft_verdict, inbox_rate
       FROM placement_results WHERE test_id = ? ORDER BY inbox_rate ASC`,
    )
    .all(latest.id) as { email: string; google_verdict: string | null; microsoft_verdict: string | null; inbox_rate: number | null }[];

  const rates = results.map((r) => r.inbox_rate).filter((r): r is number => r != null);
  const avgInboxRate = rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10 : null;
  const googleSpam = results.filter((r) => r.google_verdict === "spam").length;
  const microsoftSpam = results.filter((r) => r.microsoft_verdict === "spam").length;
  const worst = results.slice(0, 10);

  return NextResponse.json({
    ok: true,
    test: { id: latest.id, name: latest.name, sendersTested: JSON.parse(latest.emails).length, created_at: latest.created_at, completed_at: latest.completed_at },
    avgInboxRate,
    sendersWithGoogleSpamVerdict: googleSpam,
    sendersWithMicrosoftSpamVerdict: microsoftSpam,
    resultsCount: results.length,
    worstSenders: worst,
  });
}
