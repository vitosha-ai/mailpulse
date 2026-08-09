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

const clientIp = (request: NextRequest) =>
  (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

async function geo(ip: string): Promise<{ city: string; country: string }> {
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, {
      signal: AbortSignal.timeout(4000),
      headers: { "User-Agent": "mailpulse-security" },
    });
    if (r.ok) {
      const d = (await r.json()) as { city?: string; country_name?: string };
      return { city: d.city || "", country: d.country_name || "" };
    }
  } catch { /* geo is best-effort; the IP alone still drives alerts */ }
  return { city: "", country: "" };
}

async function alertAdmins(subject: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const to = (process.env.SDR_ALERT_TO || "ajay@vitoshainc.com,kartheek@vitoshainc.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const from = process.env.SDR_INVITE_FROM || "josh.ramirez@vitosha-inc.com";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  }).catch(() => undefined);
}

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

  // Security audit: record the login (IP + coarse geo + UA), bind the session
  // to this IP, and alert admins on anything unusual.
  const ip = clientIp(request);
  const { city, country } = await geo(ip);
  const ua = (request.headers.get("user-agent") || "").slice(0, 200);

  const knownIp = db
    .prepare("SELECT 1 FROM sdr_logins WHERE sdr_id = ? AND ip = ? LIMIT 1")
    .get(row.id, ip);
  const knownPlace = country
    ? db.prepare("SELECT 1 FROM sdr_logins WHERE sdr_id = ? AND country = ? LIMIT 1").get(row.id, country)
    : null;
  const hasHistory = db.prepare("SELECT 1 FROM sdr_logins WHERE sdr_id = ? LIMIT 1").get(row.id);

  db.prepare(
    "INSERT INTO sdr_logins (sdr_id, ip, city, country, user_agent) VALUES (?, ?, ?, ?, ?)",
  ).run(row.id, ip, city, country, ua);

  const place = [city, country].filter(Boolean).join(", ") || "unknown location";
  if (hasHistory && (!knownIp || (country && !knownPlace))) {
    await alertAdmins(
      `⚠ New login location: ${row.name}`,
      `${row.name} just signed in to the call desk from a location not seen before.\n\n` +
        `IP: ${ip}\nLocation: ${place}\nDevice: ${ua}\nTime (UTC): ${new Date().toISOString()}\n\n` +
        `If this isn't them, deactivate the SDR in MailPulse → Staffing → 👥 Team access ` +
        `(lockout is immediate).`,
    );
  }
  const distinctIps24h = (db
    .prepare(
      "SELECT COUNT(DISTINCT ip) AS n FROM sdr_logins WHERE sdr_id = ? AND created_at >= datetime('now','-1 day')",
    )
    .get(row.id) as { n: number }).n;
  if (distinctIps24h >= 3) {
    await alertAdmins(
      `🚨 Possible shared access: ${row.name}`,
      `${row.name} has logged in from ${distinctIps24h} different IP addresses in the last 24 hours — ` +
        `this can mean the account is being shared.\n\nLatest: ${ip} (${place})\n\n` +
        `Review and, if needed, deactivate the SDR in MailPulse → Staffing → 👥 Team access.`,
    );
  }

  const session = randomBytes(24).toString("hex");
  db.prepare(
    "UPDATE sdr_users SET session_hash = ?, session_ip = ?, otp_hash = NULL, otp_expires = NULL WHERE id = ?",
  ).run(sha256(session), ip, row.id);

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
