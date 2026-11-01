import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Admin cleanup (owner 2026-11-01, Maildoso retirement): remove domain_checks
// and placement_results rows whose domain/email no longer has ANY sender in
// the fleet. Keeps the Snapshot tiles (Spamhaus, DMARC, spam) honest after a
// provider-wide deletion. Bearer auth like the other machine endpoints.
// POST body: { dry_run?: boolean }  (default dry-run)

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { dry_run?: boolean };
  const dryRun = body.dry_run !== false;

  const db = getDb();
  const orphanDomains = db
    .prepare(
      `SELECT domain FROM domain_checks dc
       WHERE NOT EXISTS (SELECT 1 FROM senders s WHERE lower(s.email) LIKE '%@' || lower(dc.domain))`,
    )
    .all() as { domain: string }[];
  const orphanPlacement = db
    .prepare(
      `SELECT COUNT(*) AS n FROM placement_results pr
       WHERE NOT EXISTS (SELECT 1 FROM senders s WHERE lower(s.email) = lower(pr.email))`,
    )
    .get() as { n: number };

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      orphan_domain_checks: orphanDomains.length,
      orphan_placement_rows: orphanPlacement.n,
      sample_domains: orphanDomains.slice(0, 10).map((d) => d.domain),
    });
  }

  let domainsDeleted = 0;
  let placementDeleted = 0;
  const tx = db.transaction(() => {
    domainsDeleted = db
      .prepare(
        `DELETE FROM domain_checks
         WHERE NOT EXISTS (SELECT 1 FROM senders s WHERE lower(s.email) LIKE '%@' || lower(domain))`,
      )
      .run().changes;
    placementDeleted = db
      .prepare(
        `DELETE FROM placement_results
         WHERE NOT EXISTS (SELECT 1 FROM senders s WHERE lower(s.email) = lower(placement_results.email))`,
      )
      .run().changes;
  });
  tx();

  return NextResponse.json({ dry_run: false, domain_checks_deleted: domainsDeleted, placement_rows_deleted: placementDeleted });
}
