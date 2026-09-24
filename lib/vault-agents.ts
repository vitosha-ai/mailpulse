import type { ContactIn } from "./vault";

// Shape of a research_queue row → Contact Vault row (shared by the nightly
// ingest mirror and the one-off "sync agent leads" button).
export type RQ = {
  first_name: string | null; last_name: string | null; title: string | null; verified_email: string | null;
  linkedin: string | null; company: string | null; size: string | null; market: string | null;
  trigger_type: string | null; queued_date: string; direct_phone: string | null; phone: string | null;
  apollo_person_id: string | null;
};

export function rqToContact(r: RQ): ContactIn | null {
  const email = (r.verified_email || "").trim().toLowerCase();
  if (!email.includes("@")) return null;
  const employees = r.size && /^\d+$/.test(r.size) ? Number(r.size) : null;
  return {
    email,
    email_status: "verified",
    first_name: r.first_name, last_name: r.last_name, title: r.title, company: r.company,
    domain: email.split("@")[1],
    phone: r.direct_phone || r.phone || null,
    linkedin_url: r.linkedin,
    employees,
    apollo_person_id: r.apollo_person_id,
    source: "agent",
    campaign: `${(r.market || "us").toUpperCase()} agent · ${r.trigger_type || "lead"}`,
    acquired_at: r.queued_date ? `${r.queued_date}T05:00:00Z` : null,
    credits_est: 1,
  };
}
