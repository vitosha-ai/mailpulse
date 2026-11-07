"""Verify the emails of one or more campaign CSVs with BounceVerify (Apify) and
pack the deliverable rows into one Excel workbook, one sheet per campaign.

  py scripts/verify_and_pack.py lane1-aml lane2-claims ... --out "C:/Users/anumo/Downloads/proof-led-lanes.xlsx"

Apify token: APIFY_TOKEN env, else C:/linkedin-agent/.env (the paid key the owner
approved for ad-hoc runs). Cost ~$0.89 per 1,000 addresses. Verification verdicts
are written back to <csv>.verified.json so a re-run never re-pays.
"""
import argparse, csv, json, os, sys, time
from pathlib import Path
import requests

DL = Path(r"C:\Users\anumo\Downloads")
ACTOR = "bounceverify~bounceverify-email-verifier"
KEEP = {"valid", "deliverable", "ok", "safe"}          # statuses we send to
RISKY = {"catch_all", "catch-all", "accept_all", "risky", "unknown"}  # kept, flagged
DROP = {"invalid", "undeliverable", "disposable", "role", "spamtrap", "bad"}


def token():
    t = os.environ.get("APIFY_TOKEN")
    if t:
        return t
    for line in Path(r"C:\linkedin-agent\.env").read_text(encoding="utf-8").splitlines():
        if line.startswith("APIFY_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("no APIFY_TOKEN")


def verify(emails, tok):
    out = {}
    for i in range(0, len(emails), 4000):
        batch = emails[i:i + 4000]
        r = requests.post(f"https://api.apify.com/v2/acts/{ACTOR}/runs",
                          params={"token": tok, "waitForFinish": 300},
                          json={"emails": batch, "concurrency": 10, "skipInvalidSyntax": True}, timeout=330)
        r.raise_for_status()
        run = r.json()["data"]
        while run["status"] in ("READY", "RUNNING"):
            time.sleep(15)
            run = requests.get(f"https://api.apify.com/v2/actor-runs/{run['id']}", params={"token": tok}, timeout=60).json()["data"]
        if run["status"] != "SUCCEEDED":
            raise SystemExit(f"actor run {run['id']} ended {run['status']}")
        items = requests.get(f"https://api.apify.com/v2/datasets/{run['defaultDatasetId']}/items",
                             params={"token": tok, "clean": "true", "limit": 10000}, timeout=120).json()
        if items and not out:
            print("sample result:", json.dumps(items[0])[:400])
        for it in items:
            em = (it.get("email") or it.get("address") or "").lower()
            if em:
                out[em] = it
    return out


def verdict(rec):
    s = str(rec.get("status") or rec.get("result") or rec.get("deliverability") or rec.get("verdict") or "").lower()
    if s in KEEP:
        return "keep"
    if s in DROP:
        return "drop"
    if s in RISKY or "catch" in s:
        return "risky"
    return "risky"  # unknown shape: keep but flag; never silently drop


def main():
    a = argparse.ArgumentParser()
    a.add_argument("keys", nargs="+")
    a.add_argument("--out", required=True)
    a.add_argument("--angles", default="")
    a.add_argument("--skip-verify", action="store_true", help="pack without sending emails to the verifier")
    args = a.parse_args()
    tok = None if args.skip_verify else token()

    lanes = {}
    for k in args.keys:
        p = DL / f"{k}-campaign-apollo.csv"
        rows = list(csv.DictReader(p.open(encoding="utf-8-sig")))
        lanes[k] = (p, rows)

    cache_p = DL / "verification-cache.json"
    cache = json.loads(cache_p.read_text(encoding="utf-8")) if cache_p.exists() else {}
    todo = sorted({r["email"].lower() for _, rows in lanes.values() for r in rows} - set(cache))
    print(f"{len(todo)} addresses to verify ({len(cache)} cached)")
    if todo and not args.skip_verify:
        cache.update(verify(todo, tok))
        cache_p.write_text(json.dumps(cache), encoding="utf-8")

    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook(); wb.remove(wb.active)
    summary = []
    for k, (p, rows) in lanes.items():
        kept = []
        counts = {"keep": 0, "risky": 0, "drop": 0, "unverified": 0}
        for r in rows:
            rec = cache.get(r["email"].lower(), {})
            v = verdict(rec) if rec else "unverified"
            counts[v] += 1
            if v != "drop":
                kept.append({**r, "verification": v, "verifier_status": str(rec.get("status") or rec.get("result") or "")})
        # clean CSV for Smartlead
        cp = DL / f"{k}-campaign-verified.csv"
        with cp.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(kept[0].keys()) if kept else list(rows[0].keys()) + ["verification", "verifier_status"])
            w.writeheader(); w.writerows(kept)
        ws = wb.create_sheet(k[:31])
        hdr = list(kept[0].keys()) if kept else []
        ws.append(hdr)
        for c in ws[1]:
            c.font = Font(bold=True); c.fill = PatternFill("solid", fgColor="DDEBF7")
        for r in kept:
            ws.append([r[h] for h in hdr])
        for i, h in enumerate(hdr, 1):
            ws.column_dimensions[get_column_letter(i)].width = min(45, max(12, len(h) + 2))
        ws.freeze_panes = "A2"
        summary.append((k, len(rows), counts["keep"], counts["risky"], counts["drop"], len(kept)))
        print(f"{k}: {len(rows)} pulled -> keep {counts['keep']}, risky {counts['risky']}, dropped {counts['drop']} -> {len(kept)} in file")

    ws = wb.create_sheet("Summary", 0)
    ws.append(["Lane", "Pulled", "Verified deliverable", "Risky (catch-all/unknown)", "Dropped (invalid)", "Rows in sheet"])
    for c in ws[1]:
        c.font = Font(bold=True)
    for s in summary:
        ws.append(list(s))
    if args.angles and Path(args.angles).exists():
        wa = wb.create_sheet("Email angles", 1)
        for line in Path(args.angles).read_text(encoding="utf-8").splitlines():
            wa.append(line.split("\t"))
        wa.column_dimensions["A"].width = 22; wa.column_dimensions["B"].width = 120
    wb.save(args.out)
    print("xlsx:", args.out)


if __name__ == "__main__":
    main()
