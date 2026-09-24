-- Contact Vault: every person Vitosha has paid Apollo for, in one place.
-- Run once in Supabase → SQL editor. Safe to re-run.

create extension if not exists pg_trgm;

create table if not exists contacts (
  id               bigserial primary key,
  key              text not null unique,        -- lower(email), or 'apollo:<contact id>' for phone-only contacts
  email            text,
  email_status     text,                        -- verified | unavailable | unverified | ...
  unsubscribed     boolean not null default false,
  first_name       text,
  last_name        text,
  title            text,
  headline         text,
  phone            text,
  phones           jsonb,
  linkedin_url     text,
  city             text,
  state            text,
  country          text,
  company          text,
  domain           text,
  industry         text,
  employees        integer,
  apollo_contact_id text unique,
  apollo_person_id text,
  apollo_org_id    text,
  apollo_stage     text,
  apollo_labels    jsonb,
  apollo_source    text,                        -- how it got into Apollo (extension, search, csv, api)
  apollo_owner     text,
  apollo_created_at timestamptz,
  first_source     text,                        -- apollo | campaign | agent  (never overwritten)
  first_campaign   text,
  first_seen       timestamptz,                 -- when we first paid for this person (never overwritten)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists contact_sources (
  id           bigserial primary key,
  contact_id   bigint not null references contacts(id) on delete cascade,
  source       text not null,                   -- apollo | campaign | agent
  campaign     text not null default '',        -- campaign/segment or agent market
  acquired_at  timestamptz,
  credits_est  numeric not null default 0,      -- 1 per email reveal; estimate, not billing
  detail       text,
  unique (contact_id, source, campaign)
);

create table if not exists contact_events (
  id           bigserial primary key,
  contact_id   bigint not null references contacts(id) on delete cascade,
  kind         text not null,                   -- sent | replied | bounced | unsubscribed | job_change
  campaign     text,
  occurred_at  timestamptz not null default now(),
  detail       jsonb
);

create index if not exists ix_contacts_domain    on contacts(domain);
create index if not exists ix_contacts_country   on contacts(country, state);
create index if not exists ix_contacts_source    on contacts(first_source, first_campaign);
create index if not exists ix_contacts_status    on contacts(email_status);
create index if not exists ix_contacts_person    on contacts(apollo_person_id);
create index if not exists ix_contacts_seen      on contacts(first_seen desc nulls last, id desc);
create index if not exists ix_contacts_title_trgm   on contacts using gin (title gin_trgm_ops);
create index if not exists ix_contacts_company_trgm on contacts using gin (company gin_trgm_ops);
create index if not exists ix_contacts_email_trgm   on contacts using gin (email gin_trgm_ops);
create index if not exists ix_sources_contact on contact_sources(contact_id);
create index if not exists ix_events_contact  on contact_events(contact_id);

-- first_source / first_seen are set once; later upserts must not move them.
create or replace function contacts_keep_first() returns trigger language plpgsql as $$
begin
  if old.first_source is not null then new.first_source := old.first_source; end if;
  if old.first_campaign is not null then new.first_campaign := old.first_campaign; end if;
  if old.first_seen is not null and (new.first_seen is null or new.first_seen > old.first_seen) then new.first_seen := old.first_seen; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_contacts_keep_first on contacts;
create trigger trg_contacts_keep_first before update on contacts for each row execute function contacts_keep_first();

-- Read-only summaries for the MailPulse page.
create or replace view vault_stats as
select count(*)::int                                          as total,
       count(email)::int                                      as with_email,
       count(*) filter (where email_status = 'verified')::int as verified,
       count(phone)::int                                      as with_phone,
       count(distinct domain)::int                            as companies,
       count(*) filter (where unsubscribed)::int              as unsubscribed
from contacts;

create or replace view vault_by_source as
select source, campaign, count(*)::int as n, sum(credits_est)::numeric as credits_est,
       min(acquired_at) as first_at, max(acquired_at) as last_at
from contact_sources group by 1, 2 order by 3 desc;

create or replace view vault_by_country as
select coalesce(country, '(unknown)') as country, count(*)::int as n from contacts group by 1 order by 2 desc;

-- Lock the tables down: only the service key (used by MailPulse's server) can read/write.
alter table contacts        enable row level security;
alter table contact_sources enable row level security;
alter table contact_events  enable row level security;
