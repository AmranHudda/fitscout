import { uploadKeyOk } from "@/lib/uploads";

// Per-link manifest: the installed app opens straight to this key's feed, since an iPhone
// home-screen app doesn't share Safari's storage.
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!uploadKeyOk(key)) return new Response("Not found", { status: 404 });
  return new Response(
    JSON.stringify({
      name: "fitscout",
      short_name: "fitscout",
      description: "Resale finds picked for your taste.",
      start_url: `/a/${key}`,
      scope: "/",
      display: "standalone",
      background_color: "#faf9f7",
      theme_color: "#1d1b18",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    }),
    { headers: { "content-type": "application/manifest+json", "cache-control": "no-store" } },
  );
}
