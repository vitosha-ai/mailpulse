import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Manage the user's custom tag palette.
// GET → list tags with message counts. POST {name,color} → create/update.
// DELETE {name} → remove tag everywhere.
export async function GET() {
  const db = getDb();
  const tags = db
    .prepare(
      `SELECT t.name, t.color,
              (SELECT COUNT(*) FROM inbox_message_tags mt WHERE mt.tag = t.name) AS count
       FROM inbox_tags t ORDER BY t.name`,
    )
    .all();
  return NextResponse.json({ tags });
}

export async function POST(request: NextRequest) {
  const { name, color } = (await request.json()) as { name?: string; color?: string };
  const clean = (name ?? "").trim().slice(0, 40);
  if (!clean) return NextResponse.json({ error: "name required" }, { status: 400 });
  getDb()
    .prepare(
      "INSERT INTO inbox_tags (name, color) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET color = excluded.color",
    )
    .run(clean, color ?? "slate");
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const { name } = (await request.json()) as { name?: string };
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const db = getDb();
  db.prepare("DELETE FROM inbox_tags WHERE name = ?").run(name);
  db.prepare("DELETE FROM inbox_message_tags WHERE tag = ?").run(name);
  return NextResponse.json({ ok: true });
}
