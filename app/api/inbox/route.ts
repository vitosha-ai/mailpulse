import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncInbox, reclassifyWarmup } from "@/lib/inbox";
import { syncGoogleInbox } from "@/lib/google";

// GET /api/inbox — filters: category, q, unseen, flagged, pinned; sort; group.
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const category = sp.get("category");
  const q = sp.get("q");
  const unseen = sp.get("unseen");
  const flagged = sp.get("flagged");
  const pinned = sp.get("pinned");
  const tag = sp.get("tag");
  const sort = sp.get("sort") ?? "newest";
  const group = sp.get("group") ?? "";

  const fresh = sp.get("fresh");
  const where = ["m.is_warmup = 0"];
  const params: unknown[] = [];
  if (category) {
    where.push("m.category = ?");
    params.push(category);
  } else if (fresh === "1") {
    // The side pile: fresh threads that aren't recognizably campaign-related.
    // Rarely a real prospect (someone writing a brand-new email instead of
    // replying) — worth an occasional glance, never the main view.
    where.push(
      "m.is_reply = 0 AND COALESCE(m.category,'') NOT IN ('out-of-office','auto-reply','unsubscribe','junk')",
    );
  } else {
    // REPLIES-ONLY default: show mail that demonstrably responds to something
    // we sent — actual replies, plus auto-responses (OOO / bounces / opt-outs),
    // which are by nature reactions to our campaigns. Unsolicited mail
    // (including spam) can never appear here, because spam is never a reply.
    where.push(
      "(m.is_reply = 1 OR m.category IN ('out-of-office','auto-reply','unsubscribe'))",
    );
  }
  if (unseen === "1") where.push("m.seen = 0");
  if (flagged === "1") where.push("m.flagged = 1");
  if (pinned === "1") where.push("m.pinned = 1");
  if (tag) {
    where.push("EXISTS (SELECT 1 FROM inbox_message_tags mt WHERE mt.uid = m.uid AND mt.tag = ?)");
    params.push(tag);
  }
  if (q) {
    where.push("(m.from_email LIKE ? OR m.from_name LIKE ? OR m.subject LIKE ? OR m.preview LIKE ? OR m.to_email LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sortSql: Record<string, string> = {
    newest: "m.received_at DESC",
    oldest: "m.received_at ASC",
    sender: "m.from_email ASC",
    category: "m.category ASC, m.received_at DESC",
    unread: "m.seen ASC, m.received_at DESC",
  };
  // Pinned always float to the top, then the chosen sort.
  const orderBy = `m.pinned DESC, ${sortSql[sort] ?? sortSql.newest}`;

  const db = getDb();
  const messages = db
    .prepare(
      `SELECT m.uid, m.from_email, m.from_name, m.to_email, m.subject, m.preview, m.body,
              m.received_at, m.category, m.seen, m.flagged, m.pinned,
              COALESCE(
                (SELECT provider FROM senders s WHERE s.email = m.to_email),
                (SELECT provider FROM senders s WHERE s.domain = substr(m.to_email, instr(m.to_email, '@') + 1) LIMIT 1)
              ) AS esp,
              (SELECT GROUP_CONCAT(mt.tag, ',') FROM inbox_message_tags mt WHERE mt.uid = m.uid) AS tags
       FROM inbox_messages m WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy} LIMIT 500`,
    )
    .all(...params)
    .map((r) => {
      const row = r as Record<string, unknown>;
      row.tags = row.tags ? String(row.tags).split(",") : [];
      return row;
    }) as Record<string, unknown>[];

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
  const tags = db
    .prepare(
      `SELECT t.name, t.color,
              (SELECT COUNT(*) FROM inbox_message_tags mt WHERE mt.tag = t.name) AS count
       FROM inbox_tags t ORDER BY t.name`,
    )
    .all();

  const freshCount = scalar(
    "SELECT COUNT(*) n FROM inbox_messages WHERE is_warmup = 0 AND is_reply = 0 AND COALESCE(category,'') NOT IN ('out-of-office','auto-reply','unsubscribe','junk')",
  );

  return NextResponse.json({
    messages,
    groups,
    tags,
    counts: { ...Object.fromEntries(counts.map((c) => [c.category, c.n])), __fresh: freshCount },
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
    tag?: string;
  };
  const db = getDb();

  if (body.action === "sync") {
    // Read every configured mail source into the one inbox.
    const maildoso = await syncInbox();
    const google = await syncGoogleInbox();
    return NextResponse.json({ ok: true, result: [maildoso, google].filter((r) => !/not configured/.test(r)).join(" · ") || maildoso });
  }
  if (body.action === "sync-google") {
    return NextResponse.json({ ok: true, result: await syncGoogleInbox() });
  }
  if (body.action === "reclassify") {
    const n = reclassifyWarmup();
    return NextResponse.json({ ok: true, reclassified: n });
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
    case "tag": {
      const t = (body.tag ?? "").trim();
      if (!t) return NextResponse.json({ error: "tag required" }, { status: 400 });
      // Ensure the tag exists in the palette, then attach/detach.
      db.prepare("INSERT OR IGNORE INTO inbox_tags (name, color) VALUES (?, 'slate')").run(t);
      if (body.value === false) {
        db.prepare("DELETE FROM inbox_message_tags WHERE uid = ? AND tag = ?").run(body.uid, t);
      } else {
        db.prepare("INSERT OR IGNORE INTO inbox_message_tags (uid, tag) VALUES (?, ?)").run(body.uid, t);
      }
      break;
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
