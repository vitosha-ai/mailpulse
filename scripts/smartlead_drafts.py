"""Print the subject lines and bodies of Smartlead campaigns whose name matches a
pattern, using the Smartlead key stored in MailPulse settings (never printed).
Used to build Apollo audiences from the actual campaign copy.

  py scripts/smartlead_drafts.py "Databricks Lakehouse"
"""
import html, json, re, sqlite3, sys, time
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "mailpulse.db"
BASE = "https://server.smartlead.ai/api/v1"
PAT = sys.argv[1] if len(sys.argv) > 1 else r"."

key = sqlite3.connect(DB).execute("SELECT value FROM settings WHERE key='smartlead_api_key'").fetchone()[0]


def get(path):
    for i in range(5):
        r = requests.get(f"{BASE}{path}", params={"api_key": key}, timeout=60)
        if r.status_code == 429:
            time.sleep(3 * (i + 1)); continue
        r.raise_for_status()
        return r.json()
    raise SystemExit("rate limited")


def text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


camps = get("/campaigns")
camps = camps if isinstance(camps, list) else camps.get("data", [])
hits = [c for c in camps if re.search(PAT, str(c.get("name") or ""), re.I)]
print(f"{len(camps)} campaigns; {len(hits)} match /{PAT}/")
for c in hits:
    print(f"\n===== [{c['id']}] {c.get('name')}  status={c.get('status')}  created={str(c.get('created_at'))[:10]}")
    time.sleep(0.5)
    for s in get(f"/campaigns/{c['id']}/sequences"):
        delay = (s.get("seq_delay_details") or {}).get("delay_in_days")
        print(f"\n--- step {s.get('seq_number')} (+{delay}d) SUBJECT: {text(s.get('subject'))}\n{text(s.get('email_body'))}")
