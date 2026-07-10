import { getSetting, setSetting } from "./db";

// Maildoso: the API gives us the master (forwarding) inbox email + password,
// but NOT the IMAP host (its accounts-lookup endpoint currently 500s), so the
// host comes from the imap_host setting, defaulting to Maildoso's known host.
const FORWARDING_URL = "https://api.maildoso.com/v1/user/forwarding-lookup?offset=0&limit=50";
const DEFAULT_IMAP_HOST = "imap.apollo.maildoso.com";
const DEFAULT_IMAP_PORT = 993;

export type ImapCreds = { host: string; port: number; user: string; pass: string };

export async function discoverMasterInboxImap(): Promise<ImapCreds | null> {
  const token = getSetting("maildoso_api_key");
  if (!token) return null;

  let user = "";
  let pass = "";
  try {
    const res = await fetch(FORWARDING_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as { items?: Record<string, unknown>[] };
    const items = j.items ?? [];
    const master = items.find((a) => a.assignment === "MASTER") ?? items[0];
    user = String(master?.email ?? "");
    pass = String(master?.password ?? "");
  } catch {
    return null;
  }
  if (!user || !pass) return null;

  const host = getSetting("imap_host") || DEFAULT_IMAP_HOST;
  const port = Number(getSetting("imap_port") || DEFAULT_IMAP_PORT);
  // Cache the live credentials so a sync can run even if the API is briefly down.
  setSetting("imap_user", user);
  setSetting("imap_pass", pass);
  if (!getSetting("imap_host")) setSetting("imap_host", host);
  if (!getSetting("imap_port")) setSetting("imap_port", String(port));
  return { host, port, user, pass };
}
