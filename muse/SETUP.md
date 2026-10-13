# Connecting fitscout to Meta Muse

Muse connects to remote MCP servers over Streamable HTTP from Meta's cloud, so fitscout must be deployed (public HTTPS) first.

## 1. Add the connector

Endpoint: `https://<your-deployment>/api/mcp`

Muse's docs and third-party guides describe two ways in. Use whichever your Muse build shows:

- **Settings → Connectors → Add custom connector.** If it asks for a header or API key, use `Authorization: Bearer <FITSCOUT_TOKEN>`. If it only takes a URL, use `https://<your-deployment>/api/mcp?key=<FITSCOUT_TOKEN>`. Treat that URL like a password.
- **Tell Muse in chat:** "Connect to the MCP server at https://<your-deployment>/api/mcp. It needs a bearer key." Enter the key in the Secure Credentials prompt, not in the chat.

Check it worked: ask Muse to "call fitscout status".

## 2. Facebook Marketplace watch (Muse does the browsing)

Paste this once. Muse keeps running it.

> Once a day, check Facebook Marketplace for clothes for me. First call fitscout `get_taste_brief`. It has my local pickup area, my scout searches, and my hunts (specific items I want, each with an id).
> - Scout: run a few of the scout searches. Send every plausible new listing (title, price, link, every photo URL, size, neighborhood) to fitscout `judge_listings` in batches of up to 20.
> - Hunt: search for each hunt and send candidates to `judge_listings` with that hunt's `huntId`.
> Only tell me about scout picks it scores 7+ and hunt matches it scores 8+. fitscout already pings my phone with the best ones. Never message a seller, make an offer, or share my address or whereabouts without asking me first, every single time.

## 3. Depop and Poshmark (optional, uses more Muse usage)

fitscout already searches Grailed (and eBay, once keys are set) every morning, so Muse only needs the sites the server can't touch.

> Once a day, also search Depop and Poshmark (newest first) for a few of my scout searches and for each hunt. Send candidates to fitscout `judge_listings` the same way, with `huntId` for hunt searches. Same rules: never message, offer, or buy without asking me.

## 4. Everyday use

- "I want a brown Carhartt Detroit jacket, blanket lined, M, under $120" → `hunts` add (items added in the app's Tracker show up here too)
- "What am I hunting for?" / "pause the Detroit jacket" → `hunts` list / pause
- "Anything good today?" → `get_finds` (scout picks and hunt matches; "just my hunts" → section hunt)
- "Love the second one" / "Not my thing, too cropped" → `rate_find` (this is what teaches it)
- "These finds are off lately" → `tune_searches` (the tuning agent rewrites the searches now instead of waiting for morning)
- "Is $85 good for this?" → `price_check`
- "Draft a message to the seller" → `draft_offer` (text only; you send it)
- "I'm a 32 waist now" / "budget's $80 this month" → `update_taste`
- "Learn from my last 10 saved Instagram posts" → `add_inspiration` with those image URLs

## Why the approval rule matters

A YouTuber who chose "Allow Always" while Muse handled a Marketplace sale says it shared his home address with a buyer and accepted a lowball offer without asking ([TechRadar](https://www.techradar.com/ai-platforms-assistants/you-gotta-never-do-that-again-youtuber-says-metas-muse-ai-ruined-a-sale-and-gave-out-his-home-address-without-permission); Meta says Muse followed the permissions it was given, which he disputes). fitscout cannot message, offer, or buy, and the prompts above keep those actions behind your approval in Muse too.
