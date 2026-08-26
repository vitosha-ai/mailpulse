// Shared Apollo phone-reveal payload parser. Live-verified 2026-08-26: the
// webhook payload is keyed by Apollo's internal person id and NEVER carries
// an email — the original design matched by email and silently dropped
// every successful reveal (50/50 payloads received, 0 leads updated).
//
// Shape: { people: [ { id, phone_numbers: [{ sanitized_number, raw_number,
// type_cd, status_cd, confidence_cd }] } ] } — prefer a valid mobile number,
// else the first valid number, else the first number present.
export function extractPhonesByPersonId(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const people = (payload as { people?: unknown[] })?.people;
  if (!Array.isArray(people)) return out;
  for (const person of people) {
    if (!person || typeof person !== "object") continue;
    const p = person as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : null;
    const numbers = Array.isArray(p.phone_numbers) ? (p.phone_numbers as Record<string, unknown>[]) : [];
    if (!id || numbers.length === 0) continue;
    const pick =
      numbers.find((n) => n.type_cd === "mobile" && n.status_cd === "valid_number") ??
      numbers.find((n) => n.status_cd === "valid_number") ??
      numbers[0];
    const num = typeof pick.sanitized_number === "string" ? pick.sanitized_number
              : typeof pick.raw_number === "string" ? pick.raw_number : null;
    if (num) out.set(id, num);
  }
  return out;
}
