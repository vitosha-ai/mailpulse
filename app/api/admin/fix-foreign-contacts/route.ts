import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// One-time cleanup (2026-09-02, owner request): the US and Staffing agents
// lacked a person-location gate until today, so existing rows include
// contacts based abroad. The only location signal stored on a row is the
// direct phone's country code, so this marks rows whose direct_phone exists
// and does not start with +1:
//   us market       -> status 'Rejected'    (outbound board vocabulary)
//   staffing market -> status 'Bad Contact' (staffing board vocabulary)
// Only rows still in an un-worked state are touched (us: Pending/Verified;
// staffing: Pending) — anything a rep already acted on is left alone. A note
// is appended to rep_notes so the reason is visible on the board.
//
// GET  = dry run (counts + samples). POST = apply. Same bearer auth as ingest.
// Known limits, accepted: +1 cannot separate Canada from US, and foreign
// contacts WITHOUT a direct phone are invisible to this fix (re-checking them
// against Apollo would cost a credit per row).

const NOTE = "[auto 2026-09-02] Non-US contact (foreign direct-dial) — filtered per strictly-US directive";

function authed(request: NextRequest): boolean {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  return !!token && request.headers.get("authorization") === `Bearer ${token}`;
}

const WHERE = `
  COALESCE(direct_phone, '') != ''
  AND REPLACE(direct_phone, ' ', '') NOT LIKE '+1%'
  AND (
    (market = 'us' AND status IN ('Pending', 'Verified'))
    OR (market = 'staffing' AND status = 'Pending')
  )`;

export async function GET(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb();
  const byMarket = db
    .prepare(`SELECT market, COUNT(*) AS n FROM research_queue WHERE ${WHERE} GROUP BY market`)
    .all();
  const samples = db
    .prepare(`SELECT market, company, first_name, last_name, title, direct_phone, status, queued_date
              FROM research_queue WHERE ${WHERE} ORDER BY queued_date DESC LIMIT 30`)
    .all();
  return NextResponse.json({ ok: true, dryRun: true, byMarket, samples });
}

export async function POST(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = getDb();
  const us = db
    .prepare(`UPDATE research_queue
              SET status = 'Rejected',
                  rep_notes = CASE WHEN COALESCE(rep_notes,'') = '' THEN ?
                                   ELSE rep_notes || ' | ' || ? END
              WHERE market = 'us' AND ${WHERE}`)
    .run(NOTE, NOTE).changes;
  const staffing = db
    .prepare(`UPDATE research_queue
              SET status = 'Bad Contact',
                  rep_notes = CASE WHEN COALESCE(rep_notes,'') = '' THEN ?
                                   ELSE rep_notes || ' | ' || ? END
              WHERE market = 'staffing' AND ${WHERE}`)
    .run(NOTE, NOTE).changes;
  return NextResponse.json({ ok: true, applied: true, usRejected: us, staffingBadContact: staffing });
}
