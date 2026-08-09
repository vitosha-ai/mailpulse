import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { getDb } from "@/lib/db";

// Admin identity layer (behind the shared password gate — proxy does NOT
// exempt this path, so only people who already opened the app can reach it).
//
// Roles: 'super' (Kartheek) — manages admins; NOBODY can re-key or revoke the
// super admin except the super admin themselves. 'admin' (Ajay) — full app +
// SDR management, cannot touch admin accounts.
//
// Personal access keys are emailed only (Resend). Entering a key sets the
// admin_auth cookie, which is what privileged operations check. Bootstrap
// rule: a key can be issued from a password-only session ONLY while the
// account has no key yet; after that, re-keying the super requires the super.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newKey = () => `adm-${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`;

type Admin = { id: number; name: string; email: string; role: string; code_hash: string; active: number };

function seed() {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO admin_users (name, email, role) VALUES ('Kartheek', 'kartheek@vitoshainc.com', 'super')",
  ).run();
  db.prepare(
    "INSERT OR IGNORE INTO admin_users (name, email, role) VALUES ('Ajay', 'ajay@vitoshainc.com', 'admin')",
  ).run();
}

function caller(request: NextRequest): Admin | null {
  const hash = request.cookies.get("admin_auth")?.value;
  if (!hash) return null;
  return (getDb()
    .prepare("SELECT * FROM admin_users WHERE code_hash = ? AND active = 1 AND code_hash != ''")
    .get(hash) ?? null) as Admin | null;
}

async function emailKey(name: string, email: string, key: string): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return "RESEND_API_KEY not configured";
  const from = process.env.SDR_INVITE_FROM || "josh.ramirez@vitosha-inc.com";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your MailPulse admin access key",
      text:
        `Hi ${name},\n\nYour personal MailPulse admin key (keep it private):\n\n  ${key}\n\n` +
        `Enter it once under Outbound → Staffing → 👥 SDRs → "Identify" to unlock ` +
        `admin actions under your own identity.\n\n— MailPulse`,
    }),
  });
  if (!r.ok) return `Resend ${r.status}: ${(await r.text()).slice(0, 150)}`;
  return null;
}

export async function GET(request: NextRequest) {
  seed();
  const me = caller(request);
  const rows = getDb()
    .prepare("SELECT id, name, email, role, active, (code_hash != '') AS has_key FROM admin_users ORDER BY role DESC, name")
    .all();
  return NextResponse.json({ admins: rows, me: me ? { name: me.name, role: me.role } : null });
}

export async function POST(request: NextRequest) {
  seed();
  const body = (await request.json()) as { action?: string; id?: number; key?: string };
  const db = getDb();

  if (body.action === "identify") {
    const key = (body.key || "").trim();
    const row = db
      .prepare("SELECT name, role FROM admin_users WHERE code_hash = ? AND active = 1 AND code_hash != ''")
      .get(sha256(key)) as { name: string; role: string } | undefined;
    if (!row) return NextResponse.json({ error: "invalid key" }, { status: 401 });
    const res = NextResponse.json({ ok: true, name: row.name, role: row.role });
    res.cookies.set("admin_auth", sha256(key), {
      httpOnly: true, sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 180, path: "/",
    });
    return res;
  }

  if (body.action === "send_key") {
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const target = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(body.id) as Admin | undefined;
    if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });
    const me = caller(request);
    // The super admin's key can only be reissued by the super admin themselves
    // (bootstrap exception: first-ever key while none exists).
    if (target.role === "super" && target.code_hash !== "" && me?.email !== target.email) {
      return NextResponse.json({ error: "only the super admin can re-key their own account" }, { status: 403 });
    }
    // Re-keying any admin who already has a key requires the super admin.
    if (target.role !== "super" && target.code_hash !== "" && me?.role !== "super") {
      return NextResponse.json({ error: "only the super admin can re-key an admin" }, { status: 403 });
    }
    const key = newKey();
    const mailErr = await emailKey(target.name, target.email, key);
    if (mailErr) return NextResponse.json({ error: `email failed: ${mailErr}` }, { status: 502 });
    db.prepare("UPDATE admin_users SET code_hash = ?, active = 1 WHERE id = ?").run(sha256(key), body.id);
    return NextResponse.json({ ok: true, sent: true, to: target.email });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export async function PATCH(request: NextRequest) {
  seed();
  const body = (await request.json()) as { id?: number; action?: string };
  if (!body.id || !body.action) return NextResponse.json({ error: "id and action required" }, { status: 400 });
  const db = getDb();
  const me = caller(request);
  const target = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(body.id) as Admin | undefined;
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  // All admin-account changes require an identified SUPER admin — and the
  // super account itself can only ever be changed by its own holder.
  if (me?.role !== "super") {
    return NextResponse.json({ error: "only the super admin can manage admin accounts" }, { status: 403 });
  }
  if (target.role === "super" && me.email !== target.email) {
    return NextResponse.json({ error: "the super admin can only be changed by themselves" }, { status: 403 });
  }

  if (body.action === "deactivate") {
    db.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(body.id);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "activate") {
    db.prepare("UPDATE admin_users SET active = 1 WHERE id = ?").run(body.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
