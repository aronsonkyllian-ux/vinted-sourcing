/* Sourcing Vinted — coque hors ligne (cache d'abord), données en réseau d'abord. */
const V = "sourcing-bbcb4816e6";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon.png"];
const SEEN_REQ = new Request("./__seen_alerts__");

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isData = url.pathname.includes("/data/") && url.pathname.endsWith(".json");
  if (isData) {
    e.respondWith(
      fetch(req).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); return r; })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(r => {
      if (r && r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(req, c)); }
      return r;
    }).catch(() => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined));
    return hit || net;
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./#offres";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      try {
        const u = new URL(c.url);
        if (u.origin === location.origin) {
          c.focus();
          return;
        }
      } catch {}
    }
    return clients.openWindow(target);
  }));
});

self.addEventListener("periodicsync", e => {
  if (e.tag !== "sourcing-alerts") return;
  e.waitUntil(checkAlertsFromSw());
});

async function readSeen() {
  try {
    const cache = await caches.open(V);
    const hit = await cache.match(SEEN_REQ);
    if (!hit) return [];
    const data = await hit.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeSeen(ids) {
  const cache = await caches.open(V);
  await cache.put(SEEN_REQ, new Response(JSON.stringify(ids), { headers: { "Content-Type": "application/json" } }));
}

async function checkAlertsFromSw() {
  try {
    const res = await fetch("data/alerts.json", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    const offers = data.offers || [];
    if (!offers.length) return;
    const seen = new Set(await readSeen());
    const fresh = offers.filter(o => o.id && !seen.has(o.id));
    if (!fresh.length) return;
    const n = fresh.length;
    const top = fresh[0];
    const net = top.margin && top.margin.net != null ? `${top.margin.net} € nets/pc` : "";
    await self.registration.showNotification(
      n === 1 ? "Nouvelle offre sourcing" : `${n} nouvelles offres sourcing`,
      {
        body: [top.title, net].filter(Boolean).join(" · ") + (n > 1 ? ` et ${n - 1} autre${n > 2 ? "s" : ""}` : ""),
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        tag: "sourcing-new-offers",
        data: { url: "./#offres" }
      }
    );
    await writeSeen([...seen, ...fresh.map(o => o.id)]);
  } catch (err) {}
}
