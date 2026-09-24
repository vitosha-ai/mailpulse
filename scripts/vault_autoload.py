"""Keep the Contact Vault topped up while scripts/apollo_backfill.py runs (~3 days).

Every 30 minutes: load whatever the backfill has staged since last time
(scripts/vault_load.py --apollo, resumable). Stops once the backfill log says
DONE and everything staged has been loaded. Logs to data/vault_autoload.log.

Run detached, with VAULT_URL + VAULT_TOKEN in the environment (production
MailPulse and its OUTBOUND_INGEST_TOKEN), e.g. from PowerShell:
  $env:VAULT_URL="https://mailpulse-production.up.railway.app"; $env:VAULT_TOKEN="..."
  Start-Process py -ArgumentList "scripts/vault_autoload.py" -WorkingDirectory C:\mailpulse -WindowStyle Hidden
"""
import datetime, json, sqlite3, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "data" / "vault_autoload.log"
BACKFILL_LOG = ROOT / "data" / "apollo_backfill.log"
STAGING = ROOT / "data" / "contact_vault_staging.sqlite"
PROGRESS = ROOT / "data" / "vault_load_progress.json"
EVERY = 30 * 60


def log(msg):
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def pending():
    last = json.loads(PROGRESS.read_text())["rowid"] if PROGRESS.exists() else 0
    con = sqlite3.connect(STAGING)
    return con.execute("SELECT COUNT(*) FROM contacts WHERE rowid > ?", (last,)).fetchone()[0]


while True:
    try:
        n = pending()
        if n:
            log(f"loading {n} staged rows")
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "vault_load.py"), "--apollo"],
                               capture_output=True, text=True, cwd=ROOT)
            log((r.stdout.strip().splitlines() or ["(no output)"])[-1] + (f" | ERR {r.stderr.strip()[-200:]}" if r.returncode else ""))
        done = BACKFILL_LOG.exists() and "DONE." in BACKFILL_LOG.read_text(encoding="utf-8")
        if done and not pending():
            log("backfill complete and fully loaded - exiting")
            break
    except Exception as e:
        log(f"error: {e!r}")
    time.sleep(EVERY)
