import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export async function POST(request: NextRequest) {
  const { password } = (await request.json()) as { password?: string };
  const expected = process.env.MAILPULSE_PASSWORD;
  if (!expected || password !== expected) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }
  const token = createHash("sha256").update(expected).digest("hex");
  const res = NextResponse.json({ ok: true });
  res.cookies.set("mp_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
