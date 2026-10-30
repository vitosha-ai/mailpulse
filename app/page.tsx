import { redirect } from "next/navigation";

// Owner 2026-10-30: Outbound (the lead workflow) is the landing page.
// The sender-fleet dashboard lives at /fleet.
export default function Home() {
  redirect("/outbound");
}
