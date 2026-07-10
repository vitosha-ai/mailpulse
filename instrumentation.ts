// Runs once when the server process starts (Next.js instrumentation hook).
// On an always-on host (Railway) this keeps data fresh without anyone
// clicking "Sync now": a full sync shortly after boot, then every
// SYNC_EVERY_HOURS (default 4). Set SYNC_EVERY_HOURS=0 to disable.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const hours = Number(process.env.SYNC_EVERY_HOURS ?? "4");
  if (!hours || Number.isNaN(hours)) return;

  const { fullSync } = await import("./lib/sync");
  const { syncInbox } = await import("./lib/inbox");
  const { syncGoogleInbox } = await import("./lib/google");
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

  setTimeout(run, 2 * 60_000); // first sync 2 minutes after boot
  setInterval(run, hours * 3_600_000);
  console.log(`[auto-sync] scheduled every ${hours}h`);

  // The master inbox refreshes more often than the 4-hour fleet sync so
  // replies show up promptly. Every 15 minutes; safe no-op until configured.
  const inboxRun = async () => {
    try {
      const r = await syncInbox();
      if (!r.startsWith("Master inbox not configured")) console.log("[inbox-sync]", r);
    } catch (e) {
      console.error("[inbox-sync] failed:", e instanceof Error ? e.message : e);
    }
    try {
      const g = await syncGoogleInbox();
      if (g !== "Google not configured") console.log("[google-inbox]", g);
    } catch (e) {
      console.error("[google-inbox] failed:", e instanceof Error ? e.message : e);
    }
  };
  setTimeout(inboxRun, 90_000);
  setInterval(inboxRun, 15 * 60_000);
}
