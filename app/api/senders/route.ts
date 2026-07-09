import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/senders — filters: status, provider, domain, q (email/domain text),
// score (high|mid|low), warmup (high|mid|low), blocklisted (1), issue
// (spam|no-dmarc|disconnected), sort (score|warmup|bounce|limit|email), dir.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const status = sp.get("status");
  const provider = sp.get("provider");
  const domain = sp.get("domain");
  const q = sp.get("q");
  const score = sp.get("score");
  const warmup = sp.get("warmup");
  const blocklisted = sp.get("blocklisted");
  const issue = sp.get("issue");
  const sort = sp.get("sort");
  const dir = sp.get("dir") === "asc" ? "ASC" : "DESC";

  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push("s.health_status = ?");
    params.push(status);
  }
  if (provider) {
    where.push("s.provider = ?");
    params.push(provider);
  }
  if (domain) {
    where.push("s.domain = ?");
    params.push(domain);
  }
  if (q) {
    where.push("(s.email LIKE ? OR s.domain LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const band = (col: string, v: string | null) => {
    if (v === "high") where.push(`${col} >= 80`);
    else if (v === "mid") where.push(`${col} >= 60 AND ${col} < 80`);
    else if (v === "low") where.push(`${col} < 60`);
  };
  band("s.combined_score", score);
  band("s.warmup_score", warmup);
  if (blocklisted === "1") where.push(`dc.blocklists LIKE '%"listed":true%'`);
  if (issue === "no-dmarc") where.push("dc.dmarc_ok = 0");
  if (issue === "disconnected") where.push("(s.sl_smtp_ok = 0 OR s.sl_imap_ok = 0)");
  if (issue === "spam")
    where.push(
      `(EXISTS (SELECT 1 FROM placement_results pr WHERE pr.email = s.email AND (pr.google_verdict = 'spam' OR pr.microsoft_verdict = 'spam')))`,
    );

  // Sort. Default keeps worst-first (red → yellow, lowest score first).
  const sortCols: Record<string, string> = {
    score: "s.combined_score",
    warmup: "s.warmup_score",
    bounce: "s.bounce_rate",
    limit: "s.daily_limit",
    email: "s.email",
  };
  const orderBy = sort && sortCols[sort]
    ? `${sortCols[sort]} IS NULL, ${sortCols[sort]} ${dir}` // nulls always last
    : `CASE s.health_status WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END, s.combined_score ASC`;

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
       ORDER BY ${orderBy}`,
    )
    .all(...params);

  const counts = db
    .prepare("SELECT health_status, COUNT(*) AS n FROM senders GROUP BY health_status")
    .all() as { health_status: string; n: number }[];

  // Distinct domains (with sender counts) for the domain filter dropdown.
  const domains = db
    .prepare("SELECT domain, COUNT(*) AS n FROM senders WHERE domain != '' GROUP BY domain ORDER BY domain")
    .all() as { domain: string; n: number }[];

  return NextResponse.json({
    senders,
    counts: Object.fromEntries(counts.map((c) => [c.health_status, c.n])),
    domains,
    matched: senders.length,
  });
}
