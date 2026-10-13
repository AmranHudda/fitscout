import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

// Signs the 👍/👎 links in push notifications so only those links can rate a find.
export function sign(payload: string, secret = config.token) {
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
}

export function verify(payload: string, signature: string, secret = config.token) {
  if (!secret) return false;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Constant-time bearer token check for the MCP endpoint and cron route.
export function tokenMatches(given: string | null | undefined, expected = config.token) {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
