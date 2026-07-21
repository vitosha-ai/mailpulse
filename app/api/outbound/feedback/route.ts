import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// POST /api/outbound/feedback — merge rep verdicts from worked Excel exports
// back into research_queue. Machine-to-machine (bearer = OUTBOUND_INGEST_TOKEN),
// called by scripts/import-feedback.mjs.
//
// Merge rules (user-specified):
//   - any non-Pending verdict beats Pending
//   - a verdict never overwrites a DIFFERENT non-Pending verdict already in
//     the DB — that comes back as a conflict for the user to settle
//   - rep notes are appended (attributed), never replace existing notes
//   - this endpoint only writes status/rep_notes; drafts are untouched

const VALID_STATUSES = new Set(["Pending", "Verified", "Edited", "Sent", "Rejected", "Skipped"]);

type Verdict = {
  queued_date?: string;
  verified_email?: string;
  company?: string;
  trigger_detail?: string;
  status?: string;
  rep_notes?: string;
  sdr?: string; // lead-tracker fields, present when the worked file has them
  contacted_at?: string;
  response?: string;
  source?: string; // which rep file this came from (for attribution)
};

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { verdicts?: Verdict[] };
  const verdicts = Array.isArray(body.verdicts) ? body.verdicts : [];
  const db = getDb();

  const byEmail = db.prepare(
    `SELECT id, status, rep_notes FROM research_queue
     WHERE queued_date = ? AND verified_email = ? AND trigger_detail = ?`,
  );
  // Fallback for no-POC rows (no email to match on).
  const byCompany = db.prepare(
    `SELECT id, status, rep_notes FROM research_queue
     WHERE queued_date = ? AND COALESCE(verified_email,'') = '' AND company = ? AND trigger_detail = ?`,
  );
  // Tracker fields: a non-empty incoming value wins; empty never clears.
  const update = db.prepare(
    `UPDATE research_queue SET
       status = ?, rep_notes = ?,
       sdr = COALESCE(NULLIF(?, ''), sdr),
       contacted_at = COALESCE(NULLIF(?, ''), contacted_at),
       response = COALESCE(NULLIF(?, ''), response),
       updated_at = datetime('now')
     WHERE id = ?`,
  );

  let updated = 0;
  let unchanged = 0;
  const unmatched: Verdict[] = [];
  const conflicts: { verdict: Verdict; db_status: string }[] = [];

  for (const v of verdicts) {
    const status = (v.status || "").trim();
    if (!VALID_STATUSES.has(status) || status === "Pending") {
      unchanged++; // nothing to merge — Pending never overwrites anything
      continue;
    }
    const row = (
      v.verified_email
        ? byEmail.get(v.queued_date, v.verified_email, v.trigger_detail)
        : byCompany.get(v.queued_date, v.company, v.trigger_detail)
    ) as { id: number; status: string; rep_notes: string | null } | undefined;

    if (!row) {
      unmatched.push(v);
      continue;
    }

    // Existing non-Pending verdict that disagrees → conflict, no write.
    if (row.status !== "Pending" && row.status !== status) {
      conflicts.push({ verdict: v, db_status: row.status });
      continue;
    }

    // Append the rep's note (attributed) if it adds something new.
    let notes = row.rep_notes || "";
    const incoming = (v.rep_notes || "").trim();
    if (incoming && !notes.includes(incoming)) {
      const tag = v.source ? ` [${v.source}]` : "";
      notes = (notes ? notes + " | " : "") + incoming + tag;
    }

    if (row.status === status && notes === (row.rep_notes || "")) {
      unchanged++;
      continue;
    }
    update.run(status, notes, v.sdr ?? "", v.contacted_at ?? "", v.response ?? "", row.id);
    updated++;
  }

  return NextResponse.json({
    ok: true,
    received: verdicts.length,
    updated,
    unchanged,
    unmatched,
    conflicts,
  });
}
