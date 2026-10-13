# What's an interesting agent-heavy workflow you use today?

**Repo:** https://github.com/AmranHudda/fitscout · **Screenshots:** https://github.com/AmranHudda/fitscout/tree/main/docs/screenshots

I built **fitscout**, a set of agents that shop secondhand clothes for me. I uploaded 50 photos of outfits I wear. One agent pulled out 150 garments; in group shots it counts only my outfit, because my phone matches my face on-device and boxes me in the copy the model sees. A second agent turned those garments into a style profile and 40 resale searches. Every morning, a tuning agent reviews how each search performed and what I rated. It test-runs candidate searches live on Grailed and rewrites the list, logging a reason for every change. Then a scan judges every listing against my profile from its photos (size, flaws, mislabeled brands), checks the price against what similar items sold for, and pushes the best finds to a home-screen app on my phone. A tracker in the app takes a photo of something specific I want and judges listings by comparing their photos with mine. It also plugs into Meta Muse as an MCP connector, so Muse can watch Facebook Marketplace and send candidates through the same judge.

First night: its first scan judged 130 listings in under two minutes and correctly rejected sweaters in XXL because I wear L/XL. But the top pick, a black Polo quarter-zip, was basically one I already own. I told it I want new things inspired by my style, not copies. Now the judge sees what's in my photos and caps near-copies at 5/10, and the searches were rebuilt toward variations, like a Polo cable cardigan instead of another black quarter-zip.

**What the agents handle:** reading my photos, building my taste profile, writing and tuning searches, judging listings, pricing, and deciding what's worth a notification.

**Where I step in:**
- **Ground truth about me:** picking the photos, tapping myself when the face match misses, and 👍/👎 on finds, which both the judge and the tuning agent learn from.
- **Taste direction:** the agents optimize what I tell them to. "Match my photos" produced copies of my own closet; "new pieces in my lane" is a call only I could make.
- **Anything that spends money or talks to a person:** the agents can draft a message to a seller, but nothing can send it, make an offer, or buy.
- **On-device testing:** I built it in one evening with Claude Code. The agent read server logs and reproduced bugs in a headless browser, but it couldn't see my iPhone. I was its eyes there, which is how we caught uploads silently stalling after 20 photos.
