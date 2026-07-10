import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncInbox } from "@/lib/inbox";

// GET /api/inbox — filters: category, q, unseen, flagged, pinned; sort; group.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const category = sp.get("category");
  const q = sp.get("q");
  const unseen = sp.get("unseen");
  const flagged = sp.get("flagged");
  const pinned = sp.get("pinned");
  const sort = sp.get("sort") ?? "newest";
  const group = sp.get("group") ?? "";

  const where = ["is_warmup = 0"];
  const params: unknown[] = [];
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (unseen === "1") where.push("seen = 0");
  if (flagged === "1") where.push("flagged = 1");
  if (pinned === "1") where.push("pinned = 1");
  if (q) {
    where.push("(from_email LIKE ? OR from_name LIKE ? OR subject LIKE ? OR preview LIKE ? OR to_email LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sortSql: Record<string, string> = {
    newest: "received_at DESC",
    oldest: "received_at ASC",
    sender: "from_email ASC",
    category: "category ASC, received_at DESC",
    unread: "seen ASC, received_at DESC",
  };
  // Pinned always float to the top, then the chosen sort.
  const orderBy = `pinned DESC, ${sortSql[sort] ?? sortSql.newest}`;

  const db = getDb();
  const messages = db
    .prepare(
      `SELECT uid, from_email, from_name, to_email, subject, preview, body, received_at,
              category, seen, flagged, pinned
       FROM inbox_messages WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy} LIMIT 500`,
    )
    .all(...params) as Record<string, unknown>[];

  // Optional grouping done server-side so the UI just renders sections.
  let groups: { key: string; label: string; uids: number[] }[] | null = null;
  if (group) {
    const map = new Map<string, number[]>();
    for (const m of messages) {
      let key = "Other";
      if (group === "category") key = (m.category as string) || "other";
      else if (group === "sender") key = (m.from_email as string)?.split("@")[1] ?? "unknown";
      else if (group === "date") key = (m.received_at as string)?.slice(0, 10) ?? "unknown";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m.uid as number);
    }
    groups = [...map.entries()].map(([key, uids]) => ({ key, label: key, uids }));
  }

  const counts = db
    .prepare("SELECT category, COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 GROUP BY category")
    .all() as { category: string; n: number }[];
  const scalar = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  return NextResponse.json({
    messages,
    groups,
    counts: Object.fromEntries(counts.map((c) => [c.category, c.n])),
    unseen: scalar("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 AND seen = 0"),
    flaggedCount: scalar("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 AND flagged = 1"),
    pinnedCount: scalar("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 AND pinned = 1"),
    total: scalar("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0"),
    warmupFiltered: scalar("SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 1"),
  });
}

// POST actions: sync | seen | flag | pin | mark-warmup (all take uid except sync).
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    uid?: number;
    value?: boolean;
  };
  const db = getDb();

  if (body.action === "sync") {
    return NextResponse.json({ ok: true, result: await syncInbox() });
  }
  if (typeof body.uid !== "number") {
    return NextResponse.json({ error: "uid required" }, { status: 400 });
  }
  const v = body.value === false ? 0 : 1;
  switch (body.action) {
    case "seen":
      db.prepare("UPDATE inbox_messages SET seen = ? WHERE uid = ?").run(v, body.uid);
      break;
    case "flag":
      db.prepare("UPDATE inbox_messages SET flagged = ? WHERE uid = ?").run(v, body.uid);
      break;
    case "pin":
      db.prepare("UPDATE inbox_messages SET pinned = ? WHERE uid = ?").run(v, body.uid);
      break;
    case "mark-warmup":
      // User says this is warmup/not a real reply — hide it from the inbox.
      db.prepare("UPDATE inbox_messages SET is_warmup = 1 WHERE uid = ?").run(body.uid);
      break;
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
