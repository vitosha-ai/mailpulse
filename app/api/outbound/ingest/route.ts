import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// POST /api/outbound/ingest — machine-to-machine intake for the Vitosha research
// agent (a separate Railway service). Protected by a bearer token, NOT the
// browser password gate (this path is exempted in proxy.ts). Idempotent:
// INSERT OR IGNORE on (queued_date, verified_email, trigger_detail).

const COLS = [
  "first_name", "last_name", "title", "verified_email", "linkedin",
  "company", "trigger_type", "trigger_detail", "trigger_date", "source_url",
  "bucket", "detected_stack", "pillar", "proof_point",
  "subject", "email_1", "followup_day_3", "followup_day_8", "breakup_day_15",
  "confidence", "status", "rep_notes",
  "size", "researched_at", "fit_reason", "research_trail",
] as const;

type Row = Partial<Record<(typeof COLS)[number], string>>;

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { queued_date?: string; rows?: Row[] };
  const queuedDate = body.queued_date || new Date().toISOString().slice(0, 10);
  const rows = Array.isArray(body.rows) ? body.rows : [];

  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO research_queue
       (queued_date, ${COLS.join(", ")})
     VALUES (@queued_date, ${COLS.map((c) => "@" + c).join(", ")})`,
  );

  let inserted = 0;
  const insertMany = db.transaction((items: Row[]) => {
    for (const r of items) {
      const rec: Record<string, string> = { queued_date: queuedDate };
      for (const c of COLS) rec[c] = r[c] ?? "";
      if (!rec.status) rec.status = "Pending";
      inserted += stmt.run(rec).changes;
    }
  });
  insertMany(rows);

  return NextResponse.json({ ok: true, received: rows.length, inserted });
}
