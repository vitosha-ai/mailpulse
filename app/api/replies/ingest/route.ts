import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// POST /api/replies/ingest — machine-to-machine intake for the OOO miner
// (mailbox-allocator/ooo_miner.py). Bearer-token protected, exempted from the
// browser password gate in proxy.ts. Idempotent: INSERT OR IGNORE on
// (lead_email, replied_at), so re-running the miner never duplicates rows.

const COLS = [
  "replied_at", "campaign_name", "lead_email", "lead_name", "company",
  "category", "return_date", "alt_contact_name", "alt_contact_email",
  "summary", "snippet",
] as const;

type Row = Partial<Record<(typeof COLS)[number], string>>;

export async function POST(request: NextRequest) {
  const token = process.env.OUTBOUND_INGEST_TOKEN;
  if (!token) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { rows?: Row[] };
  const rows = body.rows ?? [];
  if (!rows.length) return NextResponse.json({ inserted: 0 });

  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO reply_intel (${COLS.join(", ")})
     VALUES (${COLS.map((c) => `@${c}`).join(", ")})`,
  );
  let inserted = 0;
  const tx = db.transaction((rs: Row[]) => {
    for (const r of rs) {
      if (!r.lead_email || !r.replied_at || !r.category) continue;
      const full: Record<string, string | null> = {};
      for (const c of COLS) full[c] = r[c] ?? null;
      inserted += stmt.run(full).changes;
    }
  });
  tx(rows);
  return NextResponse.json({ inserted, received: rows.length });
}
