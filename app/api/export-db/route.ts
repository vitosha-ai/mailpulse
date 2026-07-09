import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { getDb } from "@/lib/db";

// One-shot database export for migrating to a new host. Protected by the
// password gate (proxy.ts) like every other route.
export async function GET() {
  const db = getDb();
  // Fold the write-ahead log into the main file so the copy is complete.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const file = path.join(process.cwd(), "data", "mailpulse.db");
  const bytes = fs.readFileSync(file);
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="mailpulse.db"',
      "Content-Length": String(bytes.length),
    },
  });
}
