// fitscout's service worker: shows pushed finds and opens the app on tap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "fitscout", body: event.data ? event.data.text() : "" };
  }
  // iPhone requires every push to show a notification.
  event.waitUntil(
    self.registration.showNotification(data.title || "fitscout", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      for (const client of open) {
        if ("navigate" in client) return client.navigate(url).then((c) => (c || client).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
