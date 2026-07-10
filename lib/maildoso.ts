import { getSetting, setSetting } from "./db";

// Maildoso API client — used only to auto-discover the master (forwarding)
// inbox's IMAP credentials so the user doesn't have to find them by hand.
// Docs: https://developers.maildoso.com (Personal Access Token, Bearer auth).
const BASES = ["https://api.maildoso.com/v1", "https://app.maildoso.com/api/v1"];

type ImapCreds = { host: string; port: number; user: string; pass: string };

function pluck(obj: Record<string, unknown>): ImapCreds | null {
  // The forwarding/master account exposes an imap object + a password; the
  // email is the @maildoso.email address. Shapes vary, so read tolerantly.
  const email = String(obj.email ?? obj.forwarding_email ?? obj.address ?? "").toLowerCase();
  const pass = String(obj.password ?? obj.imap_password ?? "");
  const imap = (obj.imap ?? obj) as Record<string, unknown>;
  const host = String(imap.imap_host ?? imap.host ?? "");
  const port = Number(imap.port ?? imap.imap_port ?? 993);
  if (email && pass && host) return { host, port, user: email, pass };
  return null;
}

function findCreds(data: unknown): ImapCreds | null {
  // Walk the response looking for the master (@maildoso.email) forwarding box.
  const stack: unknown[] = [data];
  const candidates: ImapCreds[] = [];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const c = pluck(obj);
      if (c) candidates.push(c);
      stack.push(...Object.values(obj));
    }
  }
  // Prefer the @maildoso.email master mailbox if present.
  return candidates.find((c) => c.user.includes("@maildoso.")) ?? candidates[0] ?? null;
}

export async function discoverMasterInboxImap(): Promise<ImapCreds | null> {
  const token = getSetting("maildoso_api_key");
  if (!token) return null;
  const paths = ["/user/accounts/forwarding", "/user/forwarding", "/user/accounts-lookup", "/user/accounts"];
  for (const base of BASES) {
    for (const path of paths) {
      try {
        const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const data = await res.json();
        const creds = findCreds(data);
        if (creds) {
          // Cache into settings so later syncs skip discovery.
          setSetting("imap_host", creds.host);
          setSetting("imap_port", String(creds.port));
          setSetting("imap_user", creds.user);
          setSetting("imap_pass", creds.pass);
          return creds;
        }
      } catch {
        // try next
      }
    }
  }
  return null;
}
