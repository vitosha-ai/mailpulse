import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// /api/outbound/calls
//
// POST — machine-to-machine intake for the Zoom Phone EOD job (a separate
// Railway service). Bearer-token auth (same OUTBOUND_INGEST_TOKEN the research
// agents use); exempted from the browser password gate in proxy.ts. Idempotent:
// re-pushing a day upserts on (report_date, email), so a re-run overwrites that
// day's numbers rather than duplicating them.
//
// GET — the Outbound landing-page widget reads a date range (default 60 days).

type CallRow = {
  email: string;
  name?: string;
  calls?: number;
  outbound?: number;
  inbound?: number;
  connected?: number;
  connect_rate?: number;
  talk_seconds?: number;
  avg_seconds?: number;
  conversations?: number;
};

const NUM_COLS = [
  "calls", "outbound", "inbound", "connected",
  "connect_rate", "talk_seconds", "avg_seconds", "conversations",
] as const;

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { report_date?: string; employees?: CallRow[] };
  const reportDate = body.report_date || new Date().toISOString().slice(0, 10);
  const rows = Array.isArray(body.employees) ? body.employees : [];

  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO call_activity
       (report_date, email, name, ${NUM_COLS.join(", ")})
     VALUES
       (@report_date, @email, @name, ${NUM_COLS.map((c) => "@" + c).join(", ")})
     ON CONFLICT(report_date, email) DO UPDATE SET
       name = excluded.name,
       ${NUM_COLS.map((c) => `${c} = excluded.${c}`).join(",\n       ")},
       updated_at = datetime('now')`,
  );

  let written = 0;
  const writeMany = db.transaction((items: CallRow[]) => {
    for (const r of items) {
      const email = (r.email || "").toLowerCase().trim();
      if (!email) continue;
      const rec: Record<string, string | number> = {
        report_date: reportDate,
        email,
        name: r.name ?? "",
      };
      for (const c of NUM_COLS) rec[c] = Number(r[c] ?? 0) || 0;
      stmt.run(rec);
      written += 1;
    }
  });
  writeMany(rows);

  return NextResponse.json({ ok: true, report_date: reportDate, written });
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  // Range: explicit from/to, or a rolling window of `days` (default 60 = ~2 months).
  const days = Math.min(370, Math.max(1, Number(sp.get("days") || 60)));
  const to = sp.get("to") || new Date().toISOString().slice(0, 10);
  let from = sp.get("from");
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    from = d.toISOString().slice(0, 10);
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT report_date, email, name, calls, outbound, inbound, connected,
              connect_rate, talk_seconds, avg_seconds, conversations
         FROM call_activity
        WHERE report_date >= ? AND report_date <= ?
        ORDER BY report_date DESC, calls DESC`,
    )
    .all(from, to) as (CallRow & { report_date: string })[];

  // Distinct days present (newest first) so the widget can offer a day picker.
  const days_present = Array.from(new Set(rows.map((r) => r.report_date)));

  return NextResponse.json({ from, to, rows, days_present });
}
