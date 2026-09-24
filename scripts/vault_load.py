"""Load already-paid-for contacts into the Contact Vault through MailPulse's
/api/vault/ingest endpoint (which holds the Supabase key; this script never sees it).

Sources:
  --apollo     data/contact_vault_staging.sqlite  (from scripts/apollo_backfill.py)
  --campaigns  C:/Users/anumo/Downloads/*-campaign-apollo.csv  (the Sep 2026 pulls)

Idempotent: re-running upserts the same people. Resumable for --apollo via
data/vault_load_progress.json.

  py scripts/vault_load.py --campaigns
  py scripts/vault_load.py --apollo
Env: VAULT_URL (default http://localhost:3000), VAULT_TOKEN (default: OUTBOUND_INGEST_TOKEN from .env.local)
"""
import argparse, csv, json, os, re, sqlite3, sys, time
from datetime import datetime, timezone
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
STAGING = ROOT / "data" / "contact_vault_staging.sqlite"
PROGRESS = ROOT / "data" / "vault_load_progress.json"
DOWNLOADS = Path(r"C:\Users\anumo\Downloads")
BATCH = 1000


def token() -> str:
    t = os.environ.get("VAULT_TOKEN")
    if t:
        return t
    for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
        if line.startswith("OUTBOUND_INGEST_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no VAULT_TOKEN / OUTBOUND_INGEST_TOKEN")


def post(url, tok, rows):
    for attempt in range(5):
        r = requests.post(f"{url}/api/vault/ingest", json={"rows": rows},
                          headers={"Authorization": f"Bearer {tok}"}, timeout=300)
        if r.status_code < 500:
            r.raise_for_status()
            return r.json()
        time.sleep(5 * (attempt + 1))
    r.raise_for_status()


STAGE = {"639d6acb6f6ce300e694c5e2": "Cold", "639d6acb6f6ce300e694c5e3": "Approaching", "639d6acb6f6ce300e694c5e4": "Replied",
         "639d6acb6f6ce300e694c5e5": "Interested", "639d6acb6f6ce300e694c5e6": "Not Interested", "639d6acb6f6ce300e694c5e7": "Unresponsive",
         "639d6acb6f6ce300e694c5e8": "Do Not Contact", "639d6acb6f6ce300e694c5e9": "Bad Data", "639d6acb6f6ce300e694c5ea": "Changed Job"}


def apollo_rows(con, after_rowid):
    cur = con.execute("SELECT rowid, * FROM contacts WHERE rowid > ? ORDER BY rowid", (after_rowid,))
    cols = [d[0] for d in cur.description]
    for rec in cur:
        r = dict(zip(cols, rec))
        email = (r["email"] or "").strip().lower()
        yield r["rowid"], {
            "email": email if "@" in email else None,
            "email_status": r["email_status"],
            "unsubscribed": bool(r["email_unsubscribed"]),
            "first_name": r["first_name"], "last_name": r["last_name"], "title": r["title"], "headline": r["headline"],
            "phone": r["phone"], "phones": json.loads(r["phones_json"]) if r["phones_json"] else None,
            "linkedin_url": r["linkedin_url"], "city": r["city"], "state": r["state"], "country": r["country"],
            "company": r["company"], "domain": r["domain"], "industry": r["industry"], "employees": r["employees"],
            "apollo_contact_id": r["id"], "apollo_person_id": r["person_id"], "apollo_org_id": r["organization_id"],
            "apollo_stage": STAGE.get(r["stage_id"] or "", r["stage_id"]),
            "apollo_labels": json.loads(r["label_ids"]) if r["label_ids"] else None,
            "apollo_source": r["source_display"] or r["source"], "apollo_owner": r["owner_id"],
            "apollo_created_at": r["created_at"],
            "source": "apollo", "campaign": r["source_display"] or r["source"] or "",
            "acquired_at": r["created_at"], "credits_est": 1 if "@" in email else 0,
        }


def campaign_rows():
    for p in sorted(DOWNLOADS.glob("*-campaign-apollo.csv")):
        if p.name == "m365-campaign-apollo.csv":  # superseded by the two split files
            continue
        name = re.sub(r"-campaign-apollo\.csv$", "", p.name)
        acquired = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat()
        with p.open(newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                email = (r.get("email") or "").strip().lower()
                if "@" not in email:
                    continue
                yield {
                    "email": email, "email_status": "verified",
                    "first_name": r.get("first_name"), "last_name": r.get("last_name"), "title": r.get("title"),
                    "company": r.get("company"), "domain": r.get("domain") or email.split("@")[1],
                    "apollo_person_id": r.get("apollo_id"),
                    # the pull CSVs carry no location; every pull filtered on person location
                    "country": "United Arab Emirates" if name.startswith("uae-") else "United States",
                    "source": "campaign", "campaign": f"{name} · {r.get('segment', '')}".strip(" ·"),
                    "acquired_at": acquired, "credits_est": 1,
                }


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--apollo", action="store_true")
    a.add_argument("--campaigns", action="store_true")
    args = a.parse_args()
    url = os.environ.get("VAULT_URL", "http://localhost:3000").rstrip("/")
    tok = token()
    totals = {"contacts": 0, "sources": 0, "skipped": 0}

    def flush(rows):
        res = post(url, tok, rows)
        for k in totals:
            totals[k] += res.get(k, 0)

    if args.campaigns:
        buf = []
        for row in campaign_rows():
            buf.append(row)
            if len(buf) == BATCH:
                flush(buf); buf = []; print("campaigns:", totals, flush=True)
        if buf:
            flush(buf)
        print("campaigns done:", totals)

    if args.apollo:
        con = sqlite3.connect(STAGING)
        prog = json.loads(PROGRESS.read_text()) if PROGRESS.exists() else {"rowid": 0}
        buf, last = [], prog["rowid"]
        n = con.execute("SELECT COUNT(*) FROM contacts WHERE rowid > ?", (last,)).fetchone()[0]
        print(f"apollo: {n} rows to load (resuming after rowid {last})")
        for rowid, row in apollo_rows(con, last):
            buf.append(row); last = rowid
            if len(buf) == BATCH:
                flush(buf); buf = []
                PROGRESS.write_text(json.dumps({"rowid": last}))
                if (last // BATCH) % 20 == 0:
                    print(f"apollo: rowid {last}", totals, flush=True)
        if buf:
            flush(buf); PROGRESS.write_text(json.dumps({"rowid": last}))
        print("apollo done:", totals)


if __name__ == "__main__":
    main()
