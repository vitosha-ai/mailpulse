"""Per-campaign send statistics from Smartlead (sent / opens / replies / bounces /
positive) for campaigns whose name matches a pattern. Key comes from MailPulse
settings and is never printed.

  py scripts/smartlead_stats.py "Fabric|Business Central|Power BI|Databricks|Finance"
"""
import re, sqlite3, sys, time
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://server.smartlead.ai/api/v1"
PAT = sys.argv[1] if len(sys.argv) > 1 else r"."
key = sqlite3.connect(ROOT / "data" / "mailpulse.db").execute(
    "SELECT value FROM settings WHERE key='smartlead_api_key'").fetchone()[0]


def get(path):
    for i in range(6):
        r = requests.get(f"{BASE}{path}", params={"api_key": key}, timeout=60)
        if r.status_code == 429:
            time.sleep(3 * (i + 1)); continue
        r.raise_for_status()
        return r.json()
    raise SystemExit("rate limited")


camps = get("/campaigns")
camps = camps if isinstance(camps, list) else camps.get("data", [])
hits = [c for c in camps if re.search(PAT, str(c.get("name") or ""), re.I)]
print(f"{'campaign':62s} {'status':9s} {'created':10s} {'sent':>6s} {'uniq':>6s} {'open':>6s} {'reply':>5s} {'pos':>4s} {'bounce':>6s} {'unsub':>5s}")
for c in sorted(hits, key=lambda c: str(c.get("created_at"))):
    time.sleep(0.6)
    a = get(f"/campaigns/{c['id']}/analytics")
    g = lambda k: a.get(k) if a.get(k) is not None else "-"
    name = str(c.get("name"))[:60]
    print(f"{name:62s} {str(c.get('status'))[:9]:9s} {str(c.get('created_at'))[:10]:10s} "
          f"{str(g('sent_count')):>6s} {str(g('unique_sent_count')):>6s} {str(g('open_count')):>6s} "
          f"{str(g('reply_count')):>5s} {str(g('positive_reply_count') if 'positive_reply_count' in a else g('total_positive_count')):>4s} "
          f"{str(g('bounce_count')):>6s} {str(g('unsubscribed_count')):>5s}")
