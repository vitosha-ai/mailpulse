import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/outbound — the research queue the Vitosha agent writes nightly.
// Params: date (ISO; default = most recent queued_date), status (filter).
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const db = getDb();

  // Every day that has leads, with its lead count (drives the day navigator).
  const dates = db
    .prepare(
      "SELECT queued_date, COUNT(*) AS n FROM research_queue GROUP BY queued_date ORDER BY queued_date DESC",
    )
    .all() as { queued_date: string; n: number }[];

  const date = sp.get("date") || dates[0]?.queued_date || null;
  const status = sp.get("status");

  const where: string[] = [];
  const params: unknown[] = [];
  if (date) {
    where.push("queued_date = ?");
    params.push(date);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }

  const rows = date
    ? db
        .prepare(
          `SELECT * FROM research_queue
           ${where.length ? "WHERE " + where.join(" AND ") : ""}
           ORDER BY CASE confidence WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
                    company, id`,
        )
        .all(...params)
    : [];

  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM research_queue
       ${date ? "WHERE queued_date = ?" : ""} GROUP BY status`,
    )
    .all(...(date ? [date] : [])) as { status: string; n: number }[];

  return NextResponse.json({
    date,
    dates: dates.map((d) => d.queued_date),
    dateCounts: Object.fromEntries(dates.map((d) => [d.queued_date, d.n])),
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
}

// PATCH /api/outbound — update one row's status and/or edited draft fields.
const EDITABLE = new Set([
  "status",
  "subject",
  "email_1",
  "followup_day_3",
  "followup_day_8",
  "breakup_day_15",
  "rep_notes",
]);

export async function PATCH(request: NextRequest) {
  const body = (await request.json()) as { id?: number; fields?: Record<string, string> };
  const id = body.id;
  const fields = body.fields || {};
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (EDITABLE.has(k)) {
      cols.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (!cols.length) {
    return NextResponse.json({ error: "no editable fields" }, { status: 400 });
  }
  vals.push(id);

  getDb()
    .prepare(`UPDATE research_queue SET ${cols.join(", ")} WHERE id = ?`)
    .run(...vals);

  const row = getDb().prepare("SELECT * FROM research_queue WHERE id = ?").get(id);
  return NextResponse.json({ ok: true, row });
}
