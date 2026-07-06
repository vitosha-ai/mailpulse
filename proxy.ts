import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Password gate for the whole app (needed because the dashboard is exposed
// through a public tunnel). The password lives in .env.local; the cookie
// holds its SHA-256 so the raw password never sits in the browser.

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public paths: login screen, its API, and framework assets.
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const password = process.env.MAILPULSE_PASSWORD;
  if (!password) return NextResponse.next(); // gate disabled when no password configured

  const cookie = request.cookies.get("mp_auth")?.value;
  if (cookie && cookie === (await sha256(password))) {
    return NextResponse.next();
  }

  // APIs get a 401; pages get the login screen.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}
