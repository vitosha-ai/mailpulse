import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pauseAccount, resumeAccount, updateDailyLimit, disableWarmup, enableWarmup } from "@/lib/instantly";

// POST /api/actions — control senders from the dashboard.
// body: { action: 'pause'|'resume'|'set-limit'|'warmup-on'|'warmup-off', emails: string[], value?: number }
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    action: string;
    emails: string[];
    value?: number;
  };
  const emails = (body.emails ?? []).map((e) => e.toLowerCase());
  if (emails.length === 0) {
    return NextResponse.json({ error: "no senders selected" }, { status: 400 });
  }

  const results: { email: string; ok: boolean; error?: string }[] = [];
  const db = getDb();

  const act = async (email: string) => {
    switch (body.action) {
      case "pause":
        await pauseAccount(email);
        db.prepare("UPDATE senders SET instantly_status = 2 WHERE email = ?").run(email);
        break;
      case "resume":
        await resumeAccount(email);
        db.prepare("UPDATE senders SET instantly_status = 1 WHERE email = ?").run(email);
        break;
      case "set-limit":
        if (typeof body.value !== "number" || body.value < 0) throw new Error("value required");
        await updateDailyLimit(email, body.value);
        db.prepare("UPDATE senders SET daily_limit = ? WHERE email = ?").run(body.value, email);
        break;
      default:
        throw new Error(`unknown action ${body.action}`);
    }
  };

  if (body.action === "warmup-on" || body.action === "warmup-off") {
    // Bulk endpoints — one call for the whole selection.
    try {
      if (body.action === "warmup-on") await enableWarmup(emails);
      else await disableWarmup(emails);
      const status = body.action === "warmup-on" ? 1 : 0;
      const upd = db.prepare("UPDATE senders SET warmup_status = ? WHERE email = ?");
      for (const e of emails) {
        upd.run(status, e);
        results.push({ email: e, ok: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const email of emails) results.push({ email, ok: false, error: msg });
    }
  } else {
    for (const email of emails) {
      try {
        await act(email);
        results.push({ email, ok: true });
      } catch (e) {
        results.push({ email, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return NextResponse.json({ results });
}
