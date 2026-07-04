import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/senders?status=red&provider=maildoso&q=foo
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const status = sp.get("status");
  const provider = sp.get("provider");
  const q = sp.get("q");

  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push("health_status = ?");
    params.push(status);
  }
  if (provider) {
    where.push("provider = ?");
    params.push(provider);
  }
  if (q) {
    where.push("(email LIKE ? OR domain LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const db = getDb();
  const senders = db
    .prepare(
      `SELECT s.*,
              dc.spf_ok, dc.dkim_ok, dc.dmarc_ok, dc.blocklists, dc.mx_provider,
              (SELECT google_verdict FROM placement_results pr WHERE pr.email = s.email ORDER BY tested_at DESC LIMIT 1) AS google_verdict,
              (SELECT microsoft_verdict FROM placement_results pr WHERE pr.email = s.email ORDER BY tested_at DESC LIMIT 1) AS microsoft_verdict,
              (SELECT MAX(tested_at) FROM placement_results pr WHERE pr.email = s.email) AS last_placement_test
       FROM senders s
       LEFT JOIN domain_checks dc ON dc.domain = s.domain
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY CASE health_status WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END,
                combined_score ASC`,
    )
    .all(...params);

  const counts = db
    .prepare(
      "SELECT health_status, COUNT(*) AS n FROM senders GROUP BY health_status",
    )
    .all() as { health_status: string; n: number }[];

  return NextResponse.json({
    senders,
    counts: Object.fromEntries(counts.map((c) => [c.health_status, c.n])),
  });
}
