// Runs once when the server process starts (Next.js instrumentation hook).
// On an always-on host (Railway) this keeps data fresh without anyone
// clicking "Sync now": a full sync shortly after boot, then every
// SYNC_EVERY_HOURS (default 4). Set SYNC_EVERY_HOURS=0 to disable.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const hours = Number(process.env.SYNC_EVERY_HOURS ?? "4");
  if (!hours || Number.isNaN(hours)) return;

  const { fullSync } = await import("./lib/sync");
  let running = false;
  const run = async () => {
    if (running) return; // never overlap syncs
    running = true;
    try {
      const report = await fullSync();
      console.log("[auto-sync]", JSON.stringify(report));
    } catch (e) {
      console.error("[auto-sync] failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };

  // Instantly retired (owner 2026-11-01, subscription cancelled): the weekly
  // placement batches and verdict polling ran through Instantly and are
  // disabled with it. lib/placement.ts and the placement_* tables remain as
  // history. Fleet health now rests on Smartlead connection state.

  // SEO watchdog retired (owner 2026-10-30, "we are not using this"): widget
  // removed from /outbound and the daily runSeo schedule disabled so Serper
  // spend stops. lib/seo.ts and /api/seo remain for a future revival.

  // US Federal RFP agent (SAM.gov via Apify): once a day after 11:00 UTC
  // (~7 AM ET). Checked hourly; the date guard makes redeploys safe.
  // Emails the ranked Excel only when new opportunities arrived.
  // FEDERAL_DAILY=0 disables. No-op until APIFY_TOKEN is set.
  if (process.env.FEDERAL_DAILY !== "0") {
    const fedRun = async () => {
      try {
        const { getSetting, setSetting } = await import("./lib/db");
        const { runFederal, apifyToken } = await import("./lib/federal");
        if (!apifyToken()) return;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        if (now.getUTCHours() < 11 || getSetting("federal_daily_date") === today) return;
        setSetting("federal_daily_date", today); // claim the day first so a failure never loops
        const report = await runFederal({ email: true });
        console.log("[federal]", JSON.stringify({ ...report, newIds: report.newIds.length }));
      } catch (e) {
        console.error("[federal] failed:", e instanceof Error ? e.message : e);
      }
    };
    setTimeout(fedRun, 6 * 60_000);
    setInterval(fedRun, 3_600_000);
  }

  setTimeout(run, 2 * 60_000); // first sync 2 minutes after boot
  setInterval(run, hours * 3_600_000);
  console.log(`[auto-sync] scheduled every ${hours}h`);

  // Inbox monitoring retired (owner 2026-10-30, "we are not monitoring inbox
  // here"): the 15-minute master-inbox + Google pulls are disabled along with
  // the Inbox UI. lib/inbox.ts and lib/google.ts remain for a future revival.
}
