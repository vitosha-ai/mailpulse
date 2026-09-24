"""One-time export of every contact saved in the team's Apollo account into a
local SQLite staging file (data/contact_vault_staging.sqlite), later loaded into
the Contact Vault (Supabase). Contact search is FREE (no credits).

Apollo caps any one query at 50,000 rows (page*per_page), so the 522k contacts
are sliced exhaustively by person location: one slice per US state, one for
US-without-state, one for non-US. Slices of 50k-100k are read from both ends
(created_at asc + desc). Resumable: progress is stored per slice+direction.

Apollo limits THIS endpoint to 400 requests/hour and 2,000/day (separate from
people search), so the full export takes ~3 days. The script paces itself and
sleeps out any 429 (retry-after), so it can be left running detached:
  powershell Start-Process py -ArgumentList "scripts/apollo_backfill.py" -WindowStyle Hidden
Progress: data/apollo_backfill.log

  py scripts/apollo_backfill.py --dry-run     count every slice, fetch nothing
  py scripts/apollo_backfill.py               fetch (safe to re-run)
"""
import argparse, datetime, json, sqlite3, sys, time
from pathlib import Path
sys.path.insert(0, r"C:\vitosha-research-agent")
from apollo import Apollo, BASE  # noqa: E402  (uses APOLLO_API_KEY from that repo's .env)

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "contact_vault_staging.sqlite"
CAP, PER = 50_000, 100
SLEEP = 9.2   # ~390 req/hour: this endpoint allows 400/hour, 2,000/day
LOG = ROOT / "data" / "apollo_backfill.log"

STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
 "District of Columbia","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
 "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana",
 "Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota",
 "Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas",
 "Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming","Puerto Rico"]

def slices():
    for s in STATES:
        yield f"US/{s}", {"person_locations": [f"{s}, US"]}
    yield "US/no-state", {"person_locations": ["United States"], "person_not_locations": [f"{s}, US" for s in STATES]}
    yield "non-US", {"person_not_locations": ["United States"]}

def phones(c):
    return json.dumps([{"n": p.get("sanitized_number"), "t": p.get("type"), "s": p.get("status")}
                       for p in (c.get("phone_numbers") or [])])

def row(c):
    org = c.get("organization") if isinstance(c.get("organization"), dict) else {}
    acc = c.get("account") if isinstance(c.get("account"), dict) else {}
    return (c["id"], c.get("person_id"), c.get("first_name"), c.get("last_name"), c.get("title"), c.get("headline"),
            c.get("email"), c.get("email_status"), c.get("email_true_status"), int(bool(c.get("email_unsubscribed"))),
            c.get("sanitized_phone"), phones(c), c.get("linkedin_url"), c.get("city"), c.get("state"), c.get("country"),
            c.get("organization_name") or org.get("name") or acc.get("name"),
            org.get("primary_domain") or acc.get("domain"), c.get("organization_id"), c.get("account_id"),
            org.get("industry"), org.get("estimated_num_employees"),
            c.get("source"), c.get("source_display_name"), c.get("original_source"), c.get("creator_id"), c.get("owner_id"),
            c.get("contact_stage_id"), json.dumps(c.get("label_ids") or []), json.dumps(c.get("emailer_campaign_ids") or []),
            c.get("created_at"), c.get("updated_at"), c.get("last_activity_date"), int(bool(c.get("person_deleted"))))

COLS = ("id,person_id,first_name,last_name,title,headline,email,email_status,email_true_status,email_unsubscribed,"
        "phone,phones_json,linkedin_url,city,state,country,company,domain,organization_id,account_id,industry,"
        "employees,source,source_display,original_source,creator_id,owner_id,stage_id,label_ids,campaign_ids,"
        "created_at,updated_at,last_activity,person_deleted")

def main():
    a = argparse.ArgumentParser(); a.add_argument("--dry-run", action="store_true"); args = a.parse_args()
    ap = Apollo()
    logf = open(LOG, "a", encoding="utf-8")
    def log(msg):
        line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
        print(line, flush=True); logf.write(line + "\n"); logf.flush()
    def search(body, page, asc):
        payload = {**body, "page": page, "per_page": PER, "sort_by_field": "contact_created_at", "sort_ascending": asc}
        while True:
            try:
                r = ap.s.post(f"{BASE}/contacts/search", json=payload, timeout=60)
            except Exception as e:
                log(f"network error {str(e)[:80]} - retry in 60s"); time.sleep(60); continue
            if r.status_code == 429:
                wait = int(r.headers.get("retry-after", "600")) + 5
                log(f"rate limited (hourly left {r.headers.get('x-hourly-requests-left')}) - sleeping {wait}s")
                time.sleep(wait); continue
            if r.status_code >= 500:
                log(f"HTTP {r.status_code} - retry in 60s"); time.sleep(60); continue
            r.raise_for_status()
            time.sleep(SLEEP)
            return r.json()
    DB.parent.mkdir(exist_ok=True)
    con = sqlite3.connect(DB)
    con.executescript(f"""
      CREATE TABLE IF NOT EXISTS contacts ({','.join(c + (' TEXT' if c not in ('email_unsubscribed','employees','person_deleted') else ' INTEGER') for c in COLS.split(','))}, PRIMARY KEY(id));
      CREATE TABLE IF NOT EXISTS progress (slice TEXT, asc INTEGER, total INTEGER, next_page INTEGER, done INTEGER, PRIMARY KEY(slice, asc));
      CREATE INDEX IF NOT EXISTS ix_email ON contacts(email);""")
    grand = 0
    for name, body in slices():
        total = search(body, 1, True)["pagination"]["total_entries"]
        grand += total
        dirs = [True] if total <= CAP else [True, False]
        flag = "" if total <= CAP else (" (both ends)" if total <= 2 * CAP else "  !! OVER 100k - NEEDS SPLIT")
        log(f"{name:28s} {total:>7}{flag}")
        if args.dry_run or total == 0:
            continue
        for asc in dirs:
            pr = con.execute("SELECT next_page, done FROM progress WHERE slice=? AND asc=?", (name, int(asc))).fetchone()
            if pr and pr[1]:
                continue
            page = pr[0] if pr else 1
            last = min(CAP // PER, -(-total // PER)) if asc else -(-(total - CAP) // PER) + 2
            while page <= last:
                d = search(body, page, asc)
                cs = d.get("contacts") or []
                con.executemany(f"INSERT OR REPLACE INTO contacts ({COLS}) VALUES ({','.join('?'*34)})", [row(c) for c in cs])
                con.execute("INSERT OR REPLACE INTO progress VALUES (?,?,?,?,0)", (name, int(asc), total, page + 1))
                con.commit()
                if not cs:
                    break
                page += 1
            con.execute("INSERT OR REPLACE INTO progress VALUES (?,?,?,?,1)", (name, int(asc), total, page)); con.commit()
        have = con.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]
        log(f"   -> staged so far: {have}")
    log(f"sum of slices: {grand}")
    if not args.dry_run:
        log(f"DONE. total staged: {con.execute('SELECT COUNT(*) FROM contacts').fetchone()[0]}")

if __name__ == "__main__":
    main()
