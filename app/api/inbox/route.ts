import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncInbox } from "@/lib/inbox";

// GET /api/inbox?category=interested&q=foo&unseen=1 — list real (non-warmup) replies.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const category = sp.get("category");
  const q = sp.get("q");
  const unseen = sp.get("unseen");

  const where = ["is_warmup = 0"];
  const params: unknown[] = [];
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (unseen === "1") where.push("seen = 0");
  if (q) {
    where.push("(from_email LIKE ? OR subject LIKE ? OR preview LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const db = getDb();
  const messages = db
    .prepare(
      `SELECT uid, from_email, from_name, to_email, subject, preview, body, received_at, category, seen
       FROM inbox_messages WHERE ${where.join(" AND ")}
       ORDER BY received_at DESC LIMIT 300`,
    )
    .all(...params);

  const counts = db
    .prepare("SELECT category, COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 GROUP BY category")
    .all() as { category: string; n: number }[];
  const unseenCount = (db
    .prepare("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 AND seen = 0")
    .get() as { n: number }).n;
  const total = (db.prepare("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0").get() as { n: number }).n;
  const warmup = (db.prepare("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 1").get() as { n: number }).n;

  return NextResponse.json({
    messages,
    counts: Object.fromEntries(counts.map((c) => [c.category, c.n])),
    unseen: unseenCount,
    total,
    warmupFiltered: warmup,
  });
}

// POST { action: 'sync' } or { action: 'seen', uid } — refresh or mark read.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { action?: string; uid?: number };
  if (body.action === "sync") {
    const result = await syncInbox();
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === "seen" && typeof body.uid === "number") {
    getDb().prepare("UPDATE inbox_messages SET seen = 1 WHERE uid = ?").run(body.uid);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
