import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pauseAccount, resumeAccount, updateDailyLimit, disableWarmup, enableWarmup } from "@/lib/instantly";
import { setMaxEmailsPerDay } from "@/lib/smartlead";

// POST /api/actions — control senders from the dashboard.
// body: { action: 'pause'|'resume'|'set-limit'|'warmup-on'|'warmup-off', emails: string[], value?: number }
//
// Routing: campaigns send via Smartlead/Saleshandy, warmup via Instantly.
// Pause / resume / set-limit therefore act on the sender's SEQUENCER:
//   - Smartlead-connected → max_email_per_day (0 = paused; resume restores 30
//     or the provided value)
//   - Saleshandy-only → no pause API exists; reported back as manual work
//   - neither (warmup-only mailboxes) → falls back to the Instantly account
// warmup-on / warmup-off always act on Instantly.
const DEFAULT_RESUME_LIMIT = 30;
const DRAIN_LIMIT = 10; // retiring senders keep sending follow-ups at this trickle

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

  const db = getDb();
  const results: { email: string; ok: boolean; via?: string; error?: string }[] = [];
  const getSender = db.prepare("SELECT smartlead_id, saleshandy_id FROM senders WHERE email = ?");
  const setLocal = db.prepare("UPDATE senders SET daily_limit = ? WHERE email = ?");
  const setStatus = db.prepare("UPDATE senders SET instantly_status = ? WHERE email = ?");
  const setRetire = db.prepare(
    "UPDATE senders SET retire_requested = datetime('now') WHERE email = ?",
  );
  const clearRetire = db.prepare("UPDATE senders SET retire_requested = NULL WHERE email = ?");

  const act = async (email: string): Promise<string> => {
    const sender = getSender.get(email) as
      | { smartlead_id: string | null; saleshandy_id: string | null }
      | undefined;

    switch (body.action) {
      case "pause": {
        if (sender?.smartlead_id) {
          await setMaxEmailsPerDay(sender.smartlead_id, 0);
          setLocal.run(0, email);
          return "smartlead";
        }
        if (sender?.saleshandy_id) {
          throw new Error("Saleshandy has no pause API — pause this mailbox in Saleshandy's UI.");
        }
        await pauseAccount(email);
        setStatus.run(2, email);
        return "instantly";
      }
      case "resume": {
        const limit = typeof body.value === "number" && body.value > 0 ? body.value : DEFAULT_RESUME_LIMIT;
        clearRetire.run(email); // resuming cancels a pending retirement
        if (sender?.smartlead_id) {
          await setMaxEmailsPerDay(sender.smartlead_id, limit);
          setLocal.run(limit, email);
          return "smartlead";
        }
        if (sender?.saleshandy_id) {
          throw new Error("Saleshandy has no resume API — adjust this mailbox in Saleshandy's UI.");
        }
        await resumeAccount(email);
        setStatus.run(1, email);
        return "instantly";
      }
      case "retire": {
        // Graceful pause: throttle to a follow-ups-only trickle now; the daily
        // sync fully pauses once the sender's campaigns finish (Smartlead) or
        // its queue drains (Saleshandy → alert, no API).
        if (sender?.smartlead_id) {
          await setMaxEmailsPerDay(sender.smartlead_id, DRAIN_LIMIT);
          setLocal.run(DRAIN_LIMIT, email);
          setRetire.run(email);
          return "smartlead (draining)";
        }
        if (sender?.saleshandy_id) {
          setRetire.run(email);
          return "saleshandy (watching for queue drain — you'll get an alert when it's safe to pause)";
        }
        // Warmup-only mailbox: nothing in flight, pause immediately.
        await pauseAccount(email);
        setStatus.run(2, email);
        return "instantly";
      }
      case "set-limit": {
        if (typeof body.value !== "number" || body.value < 0) throw new Error("value required");
        if (sender?.smartlead_id) {
          await setMaxEmailsPerDay(sender.smartlead_id, body.value);
          setLocal.run(body.value, email);
          return "smartlead";
        }
        if (sender?.saleshandy_id) {
          throw new Error("Saleshandy limits must be changed in Saleshandy's UI.");
        }
        await updateDailyLimit(email, body.value);
        setLocal.run(body.value, email);
        return "instantly";
      }
      default:
        throw new Error(`unknown action ${body.action}`);
    }
  };

  if (body.action === "warmup-on" || body.action === "warmup-off") {
    try {
      if (body.action === "warmup-on") await enableWarmup(emails);
      else await disableWarmup(emails);
      const status = body.action === "warmup-on" ? 1 : 0;
      const upd = getDb().prepare("UPDATE senders SET warmup_status = ? WHERE email = ?");
      for (const e of emails) {
        upd.run(status, e);
        results.push({ email: e, ok: true, via: "instantly" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const email of emails) results.push({ email, ok: false, error: msg });
    }
  } else {
    for (const email of emails) {
      try {
        const via = await act(email);
        results.push({ email, ok: true, via });
      } catch (e) {
        results.push({ email, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      // Gentle pacing for Smartlead's tight rate limit.
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return NextResponse.json({ results });
}
