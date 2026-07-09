import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";

// One-shot database import for host migration. Writes the uploaded SQLite file
// to data/incoming.db; the swap happens on next server boot (see lib/db.ts),
// so we never overwrite a file better-sqlite3 currently holds open.
// Password-gated by proxy.ts like every route.
export async function POST(request: NextRequest) {
  const buf = Buffer.from(await request.arrayBuffer());
  // A valid SQLite file begins with this 16-byte magic header.
  if (buf.length < 100 || buf.subarray(0, 15).toString() !== "SQLite format 3") {
    return NextResponse.json({ error: "not a SQLite database" }, { status: 400 });
  }
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "incoming.db"), buf);
  return NextResponse.json({ ok: true, bytes: buf.length, note: "will be applied on next restart" });
}
