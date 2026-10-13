import webpush from "web-push";
import { config } from "./config";
import { listPushSubs, removePushSub } from "./store";

// Web Push to the home-screen app (iPhone 16.4+ once it's added to the Home Screen).
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? "";
const configured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

export interface WebPushPayload {
  title: string;
  body: string;
  url: string; // opened when the notification is tapped
  tag?: string; // a newer notification with the same tag replaces the older one
}

let ready = false;
function setup() {
  if (!ready) {
    // The subject is how push services contact the sender: the site itself, not a personal email.
    webpush.setVapidDetails(config.publicUrl.startsWith("https://") ? config.publicUrl : "https://fitscout-seven.vercel.app", process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
    ready = true;
  }
}

// Sends to every installed app; drops subscriptions the push service says are gone. Returns how many got it.
export async function sendWebPush(payload: WebPushPayload) {
  if (!configured()) return 0;
  setup();
  let sent = 0;
  await Promise.all(
    (await listPushSubs()).map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 86_400, urgency: "high" });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await removePushSub(sub.endpoint);
        else console.error(`web push failed (${status ?? "no status"}):`, (err as Error).message);
      }
    }),
  );
  return sent;
}
