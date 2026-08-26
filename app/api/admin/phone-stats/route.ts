import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Read-only diagnostic: direct-phone coverage on today's (or a given date's)
// run, per market, plus a few example rows. Same bearer-token auth as the
// other machine endpoints. Exists to verify the 2026-08-26 phone-reveal
// fixes are actually landing on fresh rows, not just the backfilled ones.

export async function GET(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const date = request.nextUrl.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const db = getDb();

  const byMarket = db
    .prepare(
      `SELECT market,
              COUNT(*) AS total,
              SUM(CASE WHEN is_prime = 1 THEN 1 ELSE 0 END) AS prime_rows,
              SUM(CASE WHEN COALESCE(apollo_person_id,'') != '' THEN 1 ELSE 0 END) AS reveal_requested,
              SUM(CASE WHEN COALESCE(direct_phone,'') != '' THEN 1 ELSE 0 END) AS has_direct_phone,
              SUM(CASE WHEN COALESCE(direct_phone,'') = '' AND COALESCE(phone,'') != '' THEN 1 ELSE 0 END) AS company_line_only
       FROM research_queue
       WHERE queued_date = ?
       GROUP BY market`,
    )
    .all(date);

  const examples = db
    .prepare(
      `SELECT market, company, first_name, last_name, title, phone, direct_phone, apollo_person_id
       FROM research_queue
       WHERE queued_date = ? AND is_prime = 1
       ORDER BY market, company
       LIMIT 25`,
    )
    .all(date);

  const lookupSize = (db.prepare("SELECT COUNT(*) AS n FROM phone_lookup").get() as { n: number }).n;

  return NextResponse.json({ ok: true, date, byMarket, examples, phoneLookupTableSize: lookupSize });
}
