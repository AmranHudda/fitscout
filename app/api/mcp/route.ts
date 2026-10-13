import { createMcpHandler } from "mcp-handler";
import { config } from "@/lib/config";
import { tokenMatches } from "@/lib/sign";
import { registerTools, SERVER_INSTRUCTIONS } from "@/lib/tools";

export const maxDuration = 300;

const handler = createMcpHandler(registerTools, {
  serverInfo: { name: "fitscout", version: "0.1.0" },
  instructions: SERVER_INSTRUCTIONS,
});

// Accepts the token as a bearer header, or as ?key= for connector UIs that only take a URL.
async function authed(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const key = new URL(req.url).searchParams.get("key");
  if (!tokenMatches(bearer, config.token) && !tokenMatches(key, config.token)) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="fitscout"' } });
  }
  return handler(req);
}

export { authed as GET, authed as POST, authed as DELETE };
