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
DATA_LEADERS = ["Chief Data Officer", "VP Data", "Head of Data", "Director of Data", "Director of Data Engineering",
                "Head of Data Engineering", "VP Analytics", "Director of Analytics", "Head of Data Science",
                "Director of Data Science", "Data Architect", "Director of Business Intelligence", "CTO", "CIO"]
NA = {"person_locations": ["United States", "Canada"], "organization_locations": ["United States", "Canada"],
      "organization_num_employees_ranges": ["200,5000"], "currently_not_using_any_of_technology_uids": ["databricks"],
      "person_titles": DATA_LEADERS}
# Smartlead draft 4129598 "Databricks Lakehouse: one platform..." (10.12.2026). Order = fit; file capped at 4,000.
CAMPAIGNS["databricks-lakehouse"] = ("databricks-lakehouse-campaign-apollo.csv", [
    ("L1-hiring-data-eng", {**NA, "q_organization_job_titles": ["data engineer", "machine learning engineer",
                                                                 "data platform engineer", "analytics engineer"],
                            "organization_job_posted_at_range": {"min": "2026-08-12", "max": "2026-10-12"}}),
    ("L2-warehouse-lake-sprawl", {**NA, "currently_using_any_of_technology_uids": [
        "amazon_redshift", "azure_synapse_analytics", "azure_synapse", "teradata", "ibm_netezza",
        "apache_hadoop", "cloudera", "apache_hive", "oracle_exadata", "google_bigquery"]}),
    ("L3-streaming-ml-no-lakehouse", {**NA, "currently_using_any_of_technology_uids": [
        "apache_kafka", "apache_spark", "apache_airflow", "tensorflow", "pytorch", "amazon_sagemaker", "mlflow", "dbt"]}),
])
# Smartlead draft 4129541 "Data & AI - Fabric" (10.12.2026). Same copy as September's Fabric
# campaign, whose 7,676 people are in the vault and skipped; these are the NEXT pools, by fit.
FAB_NO = ["microsoft_fabric", "databricks", "snowflake"]
CAMPAIGNS["fabric-2"] = ("fabric-2-campaign-apollo.csv", [
    ("F1-hiring-bi-data", {"person_titles": DATA, "organization_num_employees_ranges": ["50,5000"],
                           "currently_using_all_of_technology_uids": ["office_365"],
                           "q_organization_job_titles": ["power bi developer", "business intelligence developer",
                                                         "data engineer", "analytics engineer", "data analyst"],
                           "organization_job_posted_at_range": {"min": "2026-08-12", "max": "2026-10-12"},
                           "currently_not_using_any_of_technology_uids": FAB_NO}),
    ("F2-power-bi-1k-5k", {"person_titles": DATA, "organization_num_employees_ranges": ["1001,5000"],
                           "currently_using_any_of_technology_uids": ["microsoft_power_bi", "power_bi"],
                           "currently_not_using_any_of_technology_uids": FAB_NO}),
    ("F3-canada-ms-data", {"person_titles": DATA, "organization_num_employees_ranges": ["50,5000"],
                           "person_locations": ["Canada"], "organization_locations": ["Canada"],
                           "currently_using_any_of_technology_uids": ["microsoft_power_bi", "power_bi",
                               "sql_server_reporting_services", "microsoft_sql_server", "azure_synapse_analytics",
                               "azure_data_factory"],
                           "currently_not_using_any_of_technology_uids": FAB_NO}),
    ("F4-legacy-ms-1k-5k", {"person_titles": DATA, "organization_num_employees_ranges": ["1001,5000"],
                            "currently_using_any_of_technology_uids": ["sql_server_reporting_services",
                                "microsoft_sql_server_reporting_services", "microsoft_sql_server", "sql_server",
                                "azure_synapse_analytics", "azure_synapse", "azure_data_factory"],
                            "currently_not_using_any_of_technology_uids": ["microsoft_power_bi", "power_bi"] + FAB_NO}),
])
# Smartlead draft 4129417 "M365 - Power BI 10.12.2026": Power BI ADOPTION pitch for companies still
# reporting by hand from spreadsheets. Buyers = the people who suffer (finance/ops) + the IT head.
REPORT_BUYERS = ["CFO", "Chief Financial Officer", "Controller", "VP Finance", "Director of Finance", "FP&A Manager",
                 "Director of FP&A", "VP Operations", "Director of Operations", "COO", "CIO", "IT Director",
                 "IT Manager", "Director of Analytics"]
NO_BI = ["microsoft_power_bi", "power_bi", "tableau", "qlik", "qlikview", "looker", "domo", "sisense", "microsoft_fabric"]
ERP_ANY = ["microsoft_dynamics_365", "dynamics_365", "microsoft_dynamics_nav", "microsoft_dynamics_gp", "microsoft_dynamics",
           "netsuite", "sage_intacct", "sage_100", "sage_300", "quickbooks", "epicor", "infor", "syspro"]
CAMPAIGNS["m365-power-bi"] = ("m365-power-bi-campaign-apollo.csv", [
    ("P1-hiring-analysts", {"person_titles": REPORT_BUYERS, "organization_num_employees_ranges": ["50,1000"],
                            "currently_using_all_of_technology_uids": ["office_365"],
                            "q_organization_job_titles": ["financial analyst", "business analyst", "reporting analyst",
                                                          "data analyst", "fp&a analyst"],
                            "organization_job_posted_at_range": {"min": "2026-08-12", "max": "2026-10-12"},
                            "currently_not_using_any_of_technology_uids": NO_BI}),
    ("P2-erp-no-bi", {"person_titles": REPORT_BUYERS, "organization_num_employees_ranges": ["50,1000"],
                      "currently_using_all_of_technology_uids": ["office_365"],
                      "currently_using_any_of_technology_uids": ERP_ANY,
                      "currently_not_using_any_of_technology_uids": NO_BI}),
    ("P3-canada-no-bi", {"person_titles": REPORT_BUYERS, "organization_num_employees_ranges": ["50,1000"],
                         "person_locations": ["Canada"], "organization_locations": ["Canada"],
                         "currently_using_all_of_technology_uids": ["office_365"],
                         "currently_using_any_of_technology_uids": ERP_ANY,
                         "currently_not_using_any_of_technology_uids": NO_BI}),
])
# Smartlead draft 4129359 "D365 - Finance & Operations 10.12.2026": ADOPTION pitch (finance + ops on
# separate systems and spreadsheets). September's F&O people are in the vault and skipped.
FO_BUYERS = ["CFO", "Chief Financial Officer", "Controller", "VP Finance", "Director of Finance", "COO", "VP Operations",
             "Director of Operations", "VP Supply Chain", "Director of Supply Chain", "Head of Procurement",
             "Director of Procurement", "CIO", "IT Director", "ERP Manager", "Director of Business Systems"]
FO_NA = {"person_titles": FO_BUYERS, "person_locations": ["United States", "Canada"],
         "organization_locations": ["United States", "Canada"],
         "currently_not_using_any_of_technology_uids": ["microsoft_dynamics_365", "dynamics_365",
                                                        "microsoft_dynamics_365_finance_and_operations", "microsoft_dynamics_ax"]}
CAMPAIGNS["d365-fo-2"] = ("d365-fo-2-campaign-apollo.csv", [
    ("O1-hiring-erp-scm-roles", {**FO_NA, "organization_num_employees_ranges": ["200,5000"],
                                 "q_organization_job_titles": ["erp analyst", "erp business analyst", "supply chain analyst",
                                                               "inventory analyst", "procurement specialist",
                                                               "accounts payable specialist", "financial systems analyst"],
                                 "organization_job_posted_at_range": {"min": "2026-08-12", "max": "2026-10-12"}}),
    ("O2-outgrown-accounting", {**FO_NA, "organization_num_employees_ranges": ["200,5000"],
                                "currently_using_any_of_technology_uids": ["quickbooks", "sage_50", "sage_100", "sage_300",
                                    "sage_intacct", "microsoft_dynamics_gp", "microsoft_dynamics_nav", "xero"]}),
    ("O3-competitor-erp-1k-5k", {**FO_NA, "organization_num_employees_ranges": ["1001,5000"],
                                 "currently_using_any_of_technology_uids": ["epicor", "infor", "jd_edwards", "sage_x3",
                                                                            "syspro", "netsuite"]}),
])
TOTAL_CAP = {"databricks-lakehouse": 4000, "fabric-2": 4000, "m365-power-bi": 4000, "d365-fo-2": 4000}

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
    total_cap = TOTAL_CAP.get(args.campaign)
    held = sum(1 for p in [out] if p.exists() for _ in csv.DictReader(p.open(encoding="utf-8-sig")))
    with out.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        for seg, filters in segments:
            if total_cap and held >= total_cap:
                print(f"{seg}: skipped, file already holds {held} (cap {total_cap})")
                continue
            filters = dict(filters)
            cap = filters.pop("_cap", None)
            if total_cap:
                cap = min(cap or 10**9, total_cap - held)
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
                    held += 1
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
