import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, randomInt } from "crypto";
import { getDb } from "@/lib/db";

// SDR portal login — email OTP, every login (owner decision 2026-08-08).
// Step 1: POST {email}            -> if an active SDR, email a 6-digit code
//                                    (10-min expiry, hash stored, single use).
// Step 2: POST {email, otp}       -> verify, mint a 12h session (sdr_auth
//                                    cookie holds a random token; its hash is
//                                    stored on the SDR row).
// Nothing reusable exists: no permanent codes, sessions die daily.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function emailOtp(name: string, email: string, otp: string): Promise<string | null> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "RESEND_API_KEY not configured";
  const from = process.env.SDR_INVITE_FROM || "josh.ramirez@vitosha-inc.com";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${otp} — your call-desk login code`,
      text: `Hi ${name},\n\nYour one-time login code:\n\n  ${otp}\n\nIt expires in 10 minutes. If you didn't request it, ignore this email.\n\n— Vitosha`,
    }),
  });
  if (!r.ok) return `Resend ${r.status}`;
  return null;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { email?: string; otp?: string };
  const email = (body.email || "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const db = getDb();
  const sdr = db
    .prepare("SELECT id, name FROM sdr_users WHERE email = ? AND active = 1")
    .get(email) as { id: number; name: string } | undefined;

  // Step 1: request a code. Always answer ok (don't leak who is invited).
  if (!body.otp) {
    if (sdr) {
      const otp = String(randomInt(100000, 1000000));
      const err = await emailOtp(sdr.name, email, otp);
      if (err) return NextResponse.json({ error: `could not send code: ${err}` }, { status: 502 });
      db.prepare(
        "UPDATE sdr_users SET otp_hash = ?, otp_expires = datetime('now', '+10 minutes') WHERE id = ?",
      ).run(sha256(otp), sdr.id);
    }
    return NextResponse.json({ ok: true, sent: true });
  }

  // Step 2: verify the code.
  if (!sdr) return NextResponse.json({ error: "invalid code" }, { status: 401 });
  const row = db
    .prepare(
      "SELECT id, name FROM sdr_users WHERE id = ? AND otp_hash = ? AND otp_expires > datetime('now')",
    )
    .get(sdr.id, sha256(body.otp.trim())) as { id: number; name: string } | undefined;
  if (!row) return NextResponse.json({ error: "invalid or expired code" }, { status: 401 });

  const session = randomBytes(24).toString("hex");
  db.prepare(
    "UPDATE sdr_users SET session_hash = ?, otp_hash = NULL, otp_expires = NULL WHERE id = ?",
  ).run(sha256(session), row.id);

  const res = NextResponse.json({ ok: true, name: row.name });
  res.cookies.set("sdr_auth", session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 12, // 12h — next working day means a fresh OTP
    path: "/",
  });
  return res;
}
