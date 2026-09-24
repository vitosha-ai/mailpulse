"""Campaign list pull from Apollo (generalised from bc_pull.py).

Reuses the research agent's Apollo client (read-only import). Search is free;
each revealed email spends one credit. Resumable. People already present in any
earlier campaign CSV are skipped BEFORE reveal, so no credit is spent on them.

  py campaign_pull.py fo --dry-run
  py campaign_pull.py fo
"""
import argparse
import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, r"C:\vitosha-research-agent")
from apollo import Apollo, ApolloCreditsError  # noqa: E402

DL = Path(r"C:\Users\anumo\Downloads")

# Contact Vault (MailPulse -> Supabase). Apollo search results are redacted, so
# the "do we already own this person?" check runs on each revealed batch; rows
# the vault already holds are dropped, and every new row is written to the
# vault so the team page and the agents see it. Set VAULT_URL + VAULT_TOKEN
# (MailPulse's OUTBOUND_INGEST_TOKEN); without them the pull behaves as before.
VAULT_URL = os.environ.get("VAULT_URL", "").rstrip("/")
VAULT_TOKEN = os.environ.get("VAULT_TOKEN", "")


def vault_post(path, payload):
    if not (VAULT_URL and VAULT_TOKEN):
        return None
    try:
        r = requests.post(f"{VAULT_URL}{path}", json=payload,
                          headers={"Authorization": f"Bearer {VAULT_TOKEN}"}, timeout=120)
        r.raise_for_status()
        return r.json()
    except Exception as e:  # the vault must never break a pull
        print(f"  vault {path} failed: {str(e)[:120]}")
        return None
FIELDS = ["email", "first_name", "last_name", "title", "company", "domain", "segment", "apollo_id"]

FINANCE = ["CFO", "Chief Financial Officer", "Controller", "VP Finance", "Director of Finance"]
IT = ["CIO", "Chief Information Officer", "CTO", "VP IT", "VP Information Technology",
      "IT Director", "Director of IT", "Head of IT", "IT Manager"]
DATA = ["Chief Data Officer", "VP Data", "Head of Data", "Director of Data", "Director of Analytics",
        "VP Analytics", "Director of Business Intelligence", "Head of Analytics",
        "CIO", "Chief Information Officer", "CTO", "IT Director"]
MKT_DATA = ["CMO", "Chief Marketing Officer", "VP Marketing", "Head of Marketing",
            "Director of Marketing Operations", "Director of Marketing Technology", "Head of CRM",
            "Director of CRM", "VP Growth", "Director of Lifecycle Marketing", "Chief Data Officer",
            "VP Data", "Head of Data", "Director of Data", "Director of Analytics"]
CDP = ["segment", "segment_io", "tealium", "mparticle", "treasure_data",
       "adobe_experience_platform", "salesforce_cdp"]
ERP_BUYERS = FINANCE + ["CIO", "IT Director", "ERP Manager", "Director of Business Systems", "VP Operations"]
COMMON = {
    "person_locations": ["United States"],
    "organization_locations": ["United States"],
    "not_organization_naics_codes": ["5613", "5415", "5416", "92"],
    "contact_email_status": ["verified"],
}
M365_UIDS = ["office_365", "microsoft_office_365"]

CAMPAIGNS = {
    "fo": ("fo-campaign-apollo.csv", [
        ("F1-legacy-ax", {"person_titles": ERP_BUYERS, "organization_num_employees_ranges": ["200,1000"],
                          "currently_using_any_of_technology_uids": ["microsoft_dynamics_ax", "dynamics_ax"]}),
        ("F2-on-dynamics-365", {"person_titles": ERP_BUYERS, "organization_num_employees_ranges": ["200,1000"],
                                "currently_using_any_of_technology_uids": [
                                    "microsoft_dynamics_365", "dynamics_365",
                                    "microsoft_dynamics_365_finance_and_operations"]}),
        ("F3-competitor-erp", {"person_titles": ERP_BUYERS, "organization_num_employees_ranges": ["200,1000"],
                               "currently_using_any_of_technology_uids": [
                                   "epicor", "infor", "jd_edwards", "sage_x3", "syspro"]}),
    ]),
    "fabric": ("fabric-campaign-apollo.csv", [
        ("D3-older-azure-data", {"person_titles": DATA, "organization_num_employees_ranges": ["50,1000"],
                                 "currently_using_any_of_technology_uids": [
                                     "azure_synapse_analytics", "azure_synapse", "azure_data_factory",
                                     "microsoft_azure_data_factory", "azure_data_lake"]}),
        ("D1-power-bi-no-platform", {"person_titles": DATA, "organization_num_employees_ranges": ["50,1000"],
                                     "currently_using_any_of_technology_uids": ["microsoft_power_bi", "power_bi"],
                                     "currently_not_using_any_of_technology_uids": [
                                         "microsoft_fabric", "databricks", "snowflake"]}),
        ("D2-legacy-ms-reporting", {"person_titles": DATA, "organization_num_employees_ranges": ["50,1000"],
                                    "currently_using_any_of_technology_uids": [
                                        "sql_server_reporting_services", "microsoft_sql_server_reporting_services",
                                        "microsoft_sql_server", "sql_server"],
                                    "currently_not_using_any_of_technology_uids": [
                                        "microsoft_power_bi", "power_bi", "microsoft_fabric"]}),
        ("D4-competing-bi", {"person_titles": DATA, "organization_num_employees_ranges": ["50,1000"],
                             "currently_using_all_of_technology_uids": ["office_365"],
                             "currently_using_any_of_technology_uids": ["tableau", "qlik", "qlikview", "looker"],
                             "currently_not_using_any_of_technology_uids": [
                                 "microsoft_power_bi", "power_bi", "microsoft_fabric"]}),
    ]),
    "customerlake": ("customerlake-campaign-apollo.csv", [
        ("C1-databricks-plus-martech", {"person_titles": MKT_DATA, "organization_num_employees_ranges": ["50,5000"],
                                        "currently_using_all_of_technology_uids": ["databricks"],
                                        "currently_using_any_of_technology_uids": CDP + [
                                            "braze", "iterable", "klaviyo", "salesforce_marketing_cloud"]}),
        ("C2-databricks-only", {"person_titles": MKT_DATA, "organization_num_employees_ranges": ["50,5000"],
                                "currently_using_any_of_technology_uids": ["databricks"]}),
        ("C3-cdp-no-databricks", {"person_titles": MKT_DATA, "organization_num_employees_ranges": ["50,5000"],
                                  "currently_using_any_of_technology_uids": CDP,
                                  "currently_not_using_any_of_technology_uids": ["databricks"]}),
    ]),
    "m365": ("m365-campaign-apollo.csv", [
        ("M3-onprem-exchange", {"person_titles": IT, "organization_num_employees_ranges": ["50,1000"],
                                "currently_using_any_of_technology_uids": ["microsoft_exchange", "microsoft_exchange_server"],
                                "currently_not_using_any_of_technology_uids": M365_UIDS}),
        ("M1-google-workspace", {"person_titles": IT, "organization_num_employees_ranges": ["50,1000"],
                                 "currently_using_any_of_technology_uids": ["google_apps", "google_workspace", "gmail"],
                                 "currently_not_using_any_of_technology_uids": M365_UIDS}),
        # Copilot / agents audience: senior IT only, strict titles, 200+ employees, capped.
        ("M2-on-m365-copilot", {"person_titles": ["CIO", "Chief Information Officer", "CTO", "VP IT",
                                                  "VP Information Technology", "Head of IT"],
                                "include_similar_titles": False,
                                "organization_num_employees_ranges": ["200,1000"],
                                "currently_using_any_of_technology_uids": M365_UIDS}),
    ]),
}

D365_GCC = ["microsoft_dynamics_365", "dynamics_365", "microsoft_dynamics_365_finance_and_operations",
            "microsoft_dynamics_ax", "dynamics_ax", "microsoft_dynamics"]
UAE = {"person_locations": ["United Arab Emirates"], "currently_using_any_of_technology_uids": D365_GCC}
CAMPAIGNS["uae-fo-finance"] = ("uae-fo-finance-campaign-apollo.csv", [
    ("UAE-Finance", {**UAE, "person_titles": ["CFO", "Chief Financial Officer", "Finance Director", "Head of Finance",
                                            "Financial Controller", "VP Finance", "Group CFO", "Group Finance Director"]})])
CAMPAIGNS["uae-fo-it"] = ("uae-fo-it-campaign-apollo.csv", [
    ("UAE-IT-ERP", {**UAE, "person_titles": ["CIO", "Chief Information Officer", "IT Director", "Head of IT", "IT Manager",
                                           "ERP Manager", "Head of ERP", "Dynamics 365 Manager",
                                           "Director of Business Systems", "Head of Digital Transformation"]})])
CAMPAIGNS["uae-fo-tax"] = ("uae-fo-tax-campaign-apollo.csv", [
    ("UAE-Tax", {**UAE, "person_titles": ["Head of Tax", "Tax Director", "Tax Manager", "VP Tax", "Group Tax Manager",
                                        "Indirect Tax Manager", "VAT Manager", "Senior Tax Manager"]})])


def search_ids(ap, filters, first_page_only):
    ids, page = [], 1
    while True:
        data = ap._request("POST", "mixed_people/api_search",
                           json={**{k: v for k, v in COMMON.items() if not (k in ("organization_locations","person_locations") and "person_locations" in filters)}, **filters, "page": page, "per_page": 100})
        total = data.get("total_entries") or 0
        people = data.get("people") or []
        ids += [p["id"] for p in people if p.get("id")]
        if first_page_only or not people or page * 100 >= total:
            return ids, total
        page += 1


def load(path, ids, emails):
    if path.exists():
        with path.open(newline="", encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                ids.add(r["apollo_id"])
                emails.add(r["email"].lower())


def main():
    a = argparse.ArgumentParser()
    a.add_argument("campaign", choices=CAMPAIGNS)
    a.add_argument("--dry-run", action="store_true")
    args = a.parse_args()
    fname, segments = CAMPAIGNS[args.campaign]
    out = DL / fname
    ap = Apollo()

    seen, emails = set(), set()
    for p in DL.glob("*-campaign-apollo.csv"):   # this campaign (resume) + earlier ones (cross-campaign dedupe)
        load(p, seen, emails)

    if args.dry_run:
        for seg, filters in segments:
            filters = {k: v for k, v in filters.items() if not k.startswith("_")}
            print(f"{seg}: Apollo total={search_ids(ap, filters, True)[1]}")
        return

    new_file = not out.exists()
    with out.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        for seg, filters in segments:
            filters = dict(filters)
            cap = filters.pop("_cap", None)
            ids, total = search_ids(ap, filters, False)
            todo = [i for i in dict.fromkeys(ids) if i not in seen]
            # Ask the vault which of these people we already own — before any credit is spent.
            owned = set()
            for n in range(0, len(todo), 2000):
                res = vault_post("/api/vault/check", {"person_ids": todo[n:n + 2000]})
                owned.update(res.get("known_ids", []) if res else [])
            if owned:
                print(f"{seg}: {len(owned)} already in the Contact Vault, skipped (no credits)")
            todo = [i for i in todo if i not in owned][:cap]
            seen.update(todo)
            print(f"{seg}: Apollo total={total}, {len(todo)} to reveal ({len(ids) - len(todo)} already held)")
            written = 0
            for n in range(0, len(todo), 10):
                batch = todo[n:n + 10]
                try:
                    data = ap._request("POST", "people/bulk_match",
                                       params={"reveal_personal_emails": "false"},
                                       json={"details": [{"id": i} for i in batch]})
                except ApolloCreditsError:
                    print("Credits exhausted - stopping.")
                    return
                matches = [p for p in (data.get("matches") or []) if p]
                known = vault_post("/api/vault/check", {"emails": [p.get("email") or "" for p in matches]})
                known = set(known.get("known", [])) if known else set()
                vault_rows = []
                for p in matches:
                    email = (p.get("email") or "").strip()
                    if (not email or p.get("email_status") != "verified"
                            or email.lower() in emails or email.lower() in known):
                        continue
                    emails.add(email.lower())
                    org = p.get("organization") or {}
                    row = {
                        "email": email, "first_name": p.get("first_name", ""),
                        "last_name": p.get("last_name", ""), "title": p.get("title", ""),
                        "company": org.get("name", ""), "domain": org.get("primary_domain", ""),
                        "segment": seg, "apollo_id": p.get("id", ""),
                    }
                    w.writerow(row)
                    written += 1
                    vault_rows.append({
                        **{k: row[k] for k in ("email", "first_name", "last_name", "title", "company", "domain")},
                        "email_status": "verified", "apollo_person_id": row["apollo_id"],
                        "linkedin_url": p.get("linkedin_url"), "city": p.get("city"),
                        "state": p.get("state"), "country": p.get("country"),
                        "source": "campaign",
                        "campaign": f"{out.stem.replace('-campaign-apollo', '')} · {seg}",
                        "acquired_at": datetime.now(timezone.utc).isoformat(), "credits_est": 1,
                    })
                f.flush()
                if vault_rows:
                    vault_post("/api/vault/ingest", {"rows": vault_rows})
            print(f"{seg}: done, {written} rows written")
    print(f"CSV: {out}")


if __name__ == "__main__":
    main()
