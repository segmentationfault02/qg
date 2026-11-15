// Service worker minimal du QG : uniquement les notifications (aucun cache).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "QG", {
    body: d.body || "", tag: d.tag || undefined, icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./" }
  }));
});

// Toucher la notification ouvre l'app sur la bonne vue.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data || {}).url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(L => {
    for (const c of L) { c.postMessage({ qgOuvrir: url }); if ("focus" in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
