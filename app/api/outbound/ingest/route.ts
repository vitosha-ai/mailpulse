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

const USAGE_COLS = [
  "apollo_enrichments", "apollo_reveals", "apollo_credits", "apollo_cost_usd",
  "anthropic_calls", "anthropic_input_tokens", "anthropic_output_tokens",
  "anthropic_cost_usd", "apify_runs", "apify_cost_usd", "total_cost_usd",
] as const;

type UsageRecord = Partial<Record<(typeof USAGE_COLS)[number], number>>;

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ingest not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    queued_date?: string;
    rows?: Row[];
    usage?: UsageRecord | null;
  };
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

  // Optional per-run usage/cost record (appended, one row per agent run).
  let usageRecorded = false;
  if (body.usage && typeof body.usage === "object") {
    const rec: Record<string, number | string> = { run_date: queuedDate };
    for (const c of USAGE_COLS) rec[c] = Number(body.usage[c] ?? 0) || 0;
    db.prepare(
      `INSERT INTO agent_usage (run_date, ${USAGE_COLS.join(", ")})
       VALUES (@run_date, ${USAGE_COLS.map((c) => "@" + c).join(", ")})`,
    ).run(rec);
    usageRecorded = true;
  }

  return NextResponse.json({ ok: true, received: rows.length, inserted, usageRecorded });
}
