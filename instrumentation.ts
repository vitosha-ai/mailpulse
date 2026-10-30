// Runs once when the server process starts (Next.js instrumentation hook).
// On an always-on host (Railway) this keeps data fresh without anyone
// clicking "Sync now": a full sync shortly after boot, then every
// SYNC_EVERY_HOURS (default 4). Set SYNC_EVERY_HOURS=0 to disable.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const hours = Number(process.env.SYNC_EVERY_HOURS ?? "4");
  if (!hours || Number.isNaN(hours)) return;

  const { fullSync } = await import("./lib/sync");
  const { pollPlacementTests, pickSendersForTest, startPlacementBatch } = await import("./lib/placement");
  const { getDb } = await import("./lib/db");
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
    // Collect finished placement-test verdicts (no-op when none are running).
    try {
      const polled = await pollPlacementTests();
      if (!polled.startsWith("no running")) console.log("[placement]", polled);
    } catch (e) {
      console.error("[placement] poll failed:", e instanceof Error ? e.message : e);
    }
  };

  // Weekly automatic placement batch: rotates through Instantly-connected
  // senders (least-recently-tested, one per domain) so bench boxes graduate
  // on VERIFIED inbox placement, not just warmup-score proxies.
  // Deploy-safe: only starts when no test is running AND the newest test is
  // older than ~a week — a redeploy never spawns extra tests.
  // PLACEMENT_WEEKLY_DAYS=0 disables; PLACEMENT_BATCH_SIZE defaults to 50.
  const placementDays = Number(process.env.PLACEMENT_WEEKLY_DAYS ?? "7");
  const placementRun = async () => {
    try {
      const db = getDb();
      const runningTests = (db.prepare("SELECT COUNT(*) AS n FROM placement_tests WHERE status = 'running'").get() as { n: number }).n;
      if (runningTests > 0) return;
      const last = (db.prepare("SELECT MAX(created_at) AS t FROM placement_tests").get() as { t: string | null }).t;
      if (last && Date.now() - new Date(last.replace(" ", "T") + "Z").getTime() < (placementDays - 0.5) * 86_400_000) return;
      const emails = pickSendersForTest(Number(process.env.PLACEMENT_BATCH_SIZE ?? "50"));
      if (emails.length === 0) return;
      const id = await startPlacementBatch(emails);
      console.log(`[placement] weekly batch #${id} started: ${emails.length} sender(s), one per domain`);
    } catch (e) {
      console.error("[placement] weekly batch failed:", e instanceof Error ? e.message : e);
    }
  };
  if (placementDays > 0) {
    setTimeout(placementRun, 5 * 60_000); // first eligibility check 5 min after boot
    setInterval(placementRun, 24 * 3_600_000); // then daily; the date guard makes it weekly
  }

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
