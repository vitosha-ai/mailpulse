"""Run campaign pulls one after another (never two at once, so the vault
dedupe between campaigns holds). Reads data/pull_queue.txt — one campaign key
per line (keys from scripts/campaign_pull.py CAMPAIGNS); re-reads it every
minute, so more campaigns can be appended while it runs. A campaign whose log
already ends with "CSV:" is treated as done. Logs: data/pull-<key>.log.

Launch detached with VAULT_URL + VAULT_TOKEN in the environment.
"""
import os, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "data" / "pull_queue.txt"
LOG = ROOT / "data" / "pull_queue.log"


def log(msg):
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")


def another_pull_running() -> bool:
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
                          "Where-Object { $_.CommandLine -like '*campaign_pull.py*' } | Measure-Object).Count"],
                         capture_output=True, text=True).stdout.strip()
    return out not in ("", "0")


def done(key: str) -> bool:
    p = ROOT / "data" / f"pull-{key}.log"
    return p.exists() and "CSV:" in p.read_text(encoding="utf-8", errors="ignore")


log("queue runner started")
while True:
    keys = [k.strip() for k in QUEUE.read_text(encoding="utf-8").splitlines() if k.strip()] if QUEUE.exists() else []
    pending = [k for k in keys if not done(k)]
    if pending and not another_pull_running():
        key = pending[0]
        log(f"starting {key}")
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        with (ROOT / "data" / f"pull-{key}.log").open("a", encoding="utf-8") as out:
            rc = subprocess.run([sys.executable, str(ROOT / "scripts" / "campaign_pull.py"), key],
                                cwd=ROOT, env=env, stdout=out, stderr=subprocess.STDOUT).returncode
        log(f"finished {key} rc={rc}")
        continue
    time.sleep(60)
