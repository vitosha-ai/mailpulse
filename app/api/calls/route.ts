import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// SDR portal data API. Auth = sdr_auth cookie (hash of the SDR's access code).
// Serves ONLY the calling surface for leads assigned to THAT SDR — scores,
// ranking reasons, vein mechanics, collision flags, and other SDRs' leads
// never leave the server. Proxy-exempt (does its own auth).

type QueueRow = {
  id: number;
  queued_date: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  verified_email: string | null;
  linkedin: string | null;
  phone: string | null;
  company: string | null;
  trigger_detail: string | null;
  source_url: string | null;
  bucket: string | null;
  detected_stack: string | null;
  subject: string | null;
  email_1: string | null;
  status: string;
  rep_notes: string | null;
  size: string | null;
};

function authSdr(request: NextRequest): string | null {
  const hash = request.cookies.get("sdr_auth")?.value;
  if (!hash) return null;
  const row = getDb()
    .prepare("SELECT name FROM sdr_users WHERE code_hash = ? AND active = 1")
    .get(hash) as { name: string } | undefined;
  return row?.name ?? null;
}

// The stored detail ends with ranking reasons (secret sauce). Keep only the
// factual, SDR-safe segments: role, days open, contract acceptance, budget.
function safeDetail(detail: string | null): string {
  if (!detail) return "";
  const [rolePart, ...segs] = detail.split(" · ");
  const keep = segs.filter((s) => /^(accepts contract|budget )/.test(s.trim()));
  return [rolePart, ...keep].join(" · ");
}

export async function GET(request: NextRequest) {
  const me = authSdr(request);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDb();
  // ALL markets (owner 2026-08-08): US + GCC + staffing leads are assignable
  // to SDRs alike. The limited field set is identical; staffing details get
  // their ranking-reasons tail stripped, US/GCC trigger details are factual
  // evidence and pass through as-is.
  const rows = db
    .prepare(
      `SELECT id, queued_date, first_name, last_name, title, verified_email, linkedin,
              phone, company, trigger_detail, source_url, bucket, detected_stack,
              subject, email_1, status, rep_notes, size,
              COALESCE(NULLIF(market,''),'us') AS market
       FROM research_queue
       WHERE sdr = ?
       ORDER BY queued_date DESC, company, id`,
    )
    .all(me) as (QueueRow & { market: string })[];

  const leads = rows.map((r) =>
    r.market === "staffing" ? { ...r, trigger_detail: safeDetail(r.trigger_detail) } : r,
  );

  // Transfer targets: other active SDRs + Ajay (the manager). Names only.
  const others = (
    getDb().prepare("SELECT name FROM sdr_users WHERE active = 1 AND name != ?").all(me) as {
      name: string;
    }[]
  ).map((x) => x.name);

  return NextResponse.json({ me, leads, transferTargets: ["Ajay", ...others] });
}

export async function PATCH(request: NextRequest) {
  const me = authSdr(request);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    id?: number;
    status?: string;
    rep_notes?: string;
    transfer_to?: string;
  };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const db = getDb();
  // Ownership check: an SDR can only touch their own leads (any market).
  const owner = db
    .prepare("SELECT sdr FROM research_queue WHERE id = ?")
    .get(body.id) as { sdr: string | null } | undefined;
  if (!owner || owner.sdr !== me) {
    return NextResponse.json({ error: "not your lead" }, { status: 403 });
  }

  if (body.transfer_to) {
    const target = body.transfer_to.trim();
    const validSdr = getDb()
      .prepare("SELECT 1 FROM sdr_users WHERE name = ? AND active = 1")
      .get(target);
    if (target !== "Ajay" && !validSdr) {
      return NextResponse.json({ error: "unknown transfer target" }, { status: 400 });
    }
    db.prepare(
      "UPDATE research_queue SET sdr = ?, rep_notes = COALESCE(NULLIF(rep_notes,''),'') || ? , updated_at = datetime('now') WHERE id = ?",
    ).run(target, ` [transferred ${me} → ${target}]`, body.id);
    return NextResponse.json({ ok: true, transferred: target });
  }

  const cols: string[] = [];
  const vals: unknown[] = [];
  if (typeof body.status === "string") {
    cols.push("status = ?");
    vals.push(body.status);
  }
  if (typeof body.rep_notes === "string") {
    cols.push("rep_notes = ?");
    vals.push(body.rep_notes);
  }
  if (!cols.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  cols.push("updated_at = datetime('now')");
  vals.push(body.id);
  db.prepare(`UPDATE research_queue SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  return NextResponse.json({ ok: true });
}
