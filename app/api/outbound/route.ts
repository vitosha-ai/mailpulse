import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/outbound — the research queue the Vitosha agent writes nightly.
// Scope params (pick one):
//   date=YYYY-MM-DD              one day (default = most recent queued_date)
//   from=YYYY-MM-DD&to=YYYY-MM-DD   inclusive range; either bound optional
//   all=1                        every day
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const db = getDb();
  // Region scope: when the UI is inside a region workspace, EVERYTHING this
  // endpoint returns (rows, day counts, status counts) is scoped to it — so
  // the day navigator never advertises another region's leads.
  const market = sp.get("market");
  const mWhere = market ? "COALESCE(NULLIF(market,''),'us') = ?" : "";

  // Every day that has leads, with its lead count (drives the day navigator).
  const dates = db
    .prepare(
      `SELECT queued_date, COUNT(*) AS n FROM research_queue
       ${market ? "WHERE " + mWhere : ""}
       GROUP BY queued_date ORDER BY queued_date DESC`,
    )
    .all(...(market ? [market] : [])) as { queued_date: string; n: number }[];

  const from = sp.get("from");
  const to = sp.get("to");
  const all = sp.get("all") === "1";
  const ranged = all || !!from || !!to;
  const date = ranged ? null : sp.get("date") || dates[0]?.queued_date || null;

  const where: string[] = [];
  const params: unknown[] = [];
  if (market) {
    where.push(mWhere);
    params.push(market);
  }
  if (date) {
    where.push("queued_date = ?");
    params.push(date);
  } else if (!all) {
    if (from) {
      where.push("queued_date >= ?");
      params.push(from);
    }
    if (to) {
      where.push("queued_date <= ?");
      params.push(to);
    }
  }

  const rows =
    date || ranged
      ? db
          .prepare(
            `SELECT * FROM research_queue
             ${where.length ? "WHERE " + where.join(" AND ") : ""}
             ORDER BY queued_date DESC,
                      CASE confidence WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
                      company, id`,
          )
          .all(...params)
      : [];

  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM research_queue
       ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY status`,
    )
    .all(...params) as { status: string; n: number }[];

  return NextResponse.json({
    date,
    from: from || null,
    to: to || null,
    all,
    dates: dates.map((d) => d.queued_date),
    dateCounts: Object.fromEntries(dates.map((d) => [d.queued_date, d.n])),
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
}

// PATCH /api/outbound — update one row's status, edited draft fields, and/or
// lead-tracker fields (SDR owner, contacted date, response).
const EDITABLE = new Set([
  "status",
  "subject",
  "email_1",
  "followup_day_3",
  "followup_day_8",
  "breakup_day_15",
  "rep_notes",
  "sdr",
  "contacted_at",
  "response",
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
  cols.push("updated_at = datetime('now')"); // tracker: stamp every edit
  vals.push(id);

  getDb()
    .prepare(`UPDATE research_queue SET ${cols.join(", ")} WHERE id = ?`)
    .run(...vals);

  const row = getDb().prepare("SELECT * FROM research_queue WHERE id = ?").get(id);
  return NextResponse.json({ ok: true, row });
}
