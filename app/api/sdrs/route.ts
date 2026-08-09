import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { getDb } from "@/lib/db";

// Admin-only SDR management (behind the main password gate — proxy.ts does
// NOT exempt this path). Invite = name + email; the server generates an access
// code, stores only its hash, and EMAILS the code to the SDR via Resend.
// The code is never shown in the admin UI and never stored in plain text.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newCode = () => `sdr-${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`;

async function emailCode(name: string, email: string, code: string): Promise<string | null> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.SDR_INVITE_FROM || "josh.ramirez@vitosha-inc.com";
  if (!key) return "RESEND_API_KEY not configured on this service";
  const portal = process.env.SDR_PORTAL_URL || "https://mailpulse-production.up.railway.app/calls";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your Vitosha call-desk access",
      text:
        `Hi ${name},\n\n` +
        `You've been invited to the Vitosha staffing call desk. Your assigned leads, ` +
        `contact details, and call notes live here:\n\n  ${portal}\n\n` +
        `Your access code (keep it private):\n\n  ${code}\n\n` +
        `Open the link, enter the code once, and you're in. If the code stops working, ` +
        `ask your manager for a new one.\n\n— Vitosha`,
    }),
  });
  if (!r.ok) return `Resend ${r.status}: ${(await r.text()).slice(0, 150)}`;
  return null;
}

export async function GET() {
  const rows = getDb()
    .prepare("SELECT id, name, email, active, created_at FROM sdr_users ORDER BY active DESC, name")
    .all();
  return NextResponse.json({ sdrs: rows });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { name?: string; email?: string };
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "name and a valid email are required" }, { status: 400 });
  }

  const code = newCode();
  try {
    getDb()
      .prepare("INSERT INTO sdr_users (name, email, code_hash) VALUES (?, ?, ?)")
      .run(name, email, sha256(code));
  } catch {
    return NextResponse.json({ error: "an SDR with that name or email already exists" }, { status: 409 });
  }

  const mailErr = await emailCode(name, email, code);
  if (mailErr) {
    // Invite without a delivered code is useless — roll back so the admin can retry.
    getDb().prepare("DELETE FROM sdr_users WHERE name = ?").run(name);
    return NextResponse.json({ error: `invite email failed: ${mailErr}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, name, email, sent: true });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json()) as { id?: number; action?: string };
  if (!body.id || !body.action) {
    return NextResponse.json({ error: "id and action required" }, { status: 400 });
  }
  const db = getDb();
  const user = db.prepare("SELECT name, email FROM sdr_users WHERE id = ?").get(body.id) as
    | { name: string; email: string }
    | undefined;
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.action === "deactivate") {
    db.prepare("UPDATE sdr_users SET active = 0 WHERE id = ?").run(body.id);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "activate") {
    db.prepare("UPDATE sdr_users SET active = 1 WHERE id = ?").run(body.id);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "regenerate") {
    const code = newCode();
    const mailErr = await emailCode(user.name, user.email, code);
    if (mailErr) return NextResponse.json({ error: `invite email failed: ${mailErr}` }, { status: 502 });
    db.prepare("UPDATE sdr_users SET code_hash = ?, active = 1 WHERE id = ?").run(sha256(code), body.id);
    return NextResponse.json({ ok: true, sent: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
