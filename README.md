# MailPulse — sender health monitor

MailPulse watches the health of our ~900 cold-email sender mailboxes and warns us **before** a sender starts landing in spam — so we never waste prospects or burn domains on a bad mailbox. It pulls data automatically from the tools we already use (Instantly, Smartlead, Saleshandy, TrulyInbox) plus public DNS/blocklist checks, and turns it into one score per sender.

## Starting the app

```
cd C:\mailpulse
npm run dev
```

Then open **http://localhost:3000** in your browser. All data stays on this machine.

## The 5-minute daily routine

1. Click **⟳ Sync now** (top right) and wait for it to finish (a few minutes).
2. Look at the **alerts panel** — handle anything red/critical first. Each alert says what happened and what to do.
3. Click the **Critical** and **Degrading** cards to filter to problem senders.
4. Use the **Action** column — it says `✓ keep going`, `↓ slow down`, or `⏸ pause now` per sender.
5. To act: tick the checkboxes → use **Pause / Resume / Set limit…** in the black bar. Changes are pushed to the sending tools automatically.

## Reading the table

| Column | Meaning |
|---|---|
| **Score** | Overall health 0–100. **80+ green** = healthy · **60–79 yellow** = watch it · **below 60 red** = stop sending |
| **Warmup** | Warmup health from Instantly / Smartlead / TrulyInbox (0–100) |
| **Bounce** | % of campaign emails bouncing (from Saleshandy). Over 3% = problem |
| **Gmail / Microsoft** | Latest real placement-test verdict at that provider (inbox or spam) |
| **Auth** | ✓✓✓ = SPF / DKIM / DMARC records OK. Any ✗ = quick DNS fix needed |
| **Limit** | Max emails/day this mailbox may send |
| **Action** | What to do with this sender right now |

A **BLOCKLISTED** badge means the sender's domain is on a spam blocklist:
- **Spamhaus listing → red/critical.** Pause its senders, look the domain up at check.spamhaus.org, consider replacing the domain.
- **Secondary list (SURBL etc.) → yellow/warning.** Reduce volume, monitor, raise with the domain provider (e.g. Maildoso).

## Common alerts and responses

- **"warmup mail landed in spam"** — sender is degrading. Slow it down (Set limit…) and watch for a few days.
- **"health score dropped N points"** — same treatment; the trend matters more than the number.
- **"disconnected in Smartlead / TrulyInbox error"** — the tool silently stopped using this mailbox. Reconnect it in that tool.
- **"exceed 30/day total policy"** — campaign limit + warmup sends together exceed our 30/day-per-mailbox policy. Lower one of them.
- **"domain is listed on SPAMHAUS"** — pause all senders on that domain immediately (see above).

## Pause vs. Retire (important distinction)

- **⏸ Pause** — stops the sender immediately. Its prospects mid-sequence stall until you resume (follow-ups are never handed to other mailboxes — that's how Smartlead/Saleshandy work by design).
- **◐ Retire** — the graceful version: throttles the sender to 10 emails/day so existing conversations get their follow-ups (Smartlead documentedly prioritizes follow-ups over new leads), then **auto-pauses fully once all its campaigns finish**. Saleshandy senders instead get watched until their queue drains 3 days, then an alert says it's safe to pause manually.
- Caveat: in evergreen campaigns (new leads added forever), Retire never auto-completes — the 10/day trickle is the protection. And a retiring sender can still pick up a few new leads once its follow-up backlog shrinks; fully preventing that is only possible at campaign level.
- Never remove a mailbox from a campaign as a way to pause it — Smartlead permanently strands its mid-sequence prospects (documented).

## Buttons worth knowing

- **▶ Placement test (next 50)** — sends real test emails from the 50 least-recently-tested senders to seed inboxes and records inbox/spam per provider. Requires the Instantly Inbox Placement add-on ($47/mo); covers Instantly-connected (Maildoso) senders.
- **⤓ Export pause list** — CSV of all yellow/red senders, e.g. for a Maildoso support ticket.
- **⚙ Settings** — API keys for Instantly, Saleshandy, Smartlead, TrulyInbox, Spamhaus. Keys are stored only on this machine and shown masked.

## What runs where (for context)

- **Instantly** warms the Maildoso mailboxes and runs placement tests.
- **Smartlead** sequences + warms the non-Maildoso mailboxes.
- **Saleshandy** sequences; its mailboxes warm in **TrulyInbox**.
- MailPulse only *reads* from all of them — except the explicit Pause/Resume/Set-limit actions you trigger.
