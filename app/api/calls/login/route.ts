import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getDb } from "@/lib/db";

// SDR portal login: exchange an access code for the sdr_auth cookie.
// Proxy-exempt; the code itself is the credential. The cookie holds the code's
// SHA-256 (same value stored in sdr_users), so the raw code never persists.

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { code?: string };
  const code = (body.code || "").trim();
  if (!code) return NextResponse.json({ error: "code required" }, { status: 400 });

  const hash = createHash("sha256").update(code).digest("hex");
  const row = getDb()
    .prepare("SELECT name FROM sdr_users WHERE code_hash = ? AND active = 1")
    .get(hash) as { name: string } | undefined;
  if (!row) return NextResponse.json({ error: "invalid or deactivated code" }, { status: 401 });

  const res = NextResponse.json({ ok: true, name: row.name });
  res.cookies.set("sdr_auth", hash, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 90,
    path: "/",
  });
  return res;
}
