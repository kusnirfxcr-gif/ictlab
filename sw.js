// Offline cache for Tape. Network first, cache as fallback, so new versions always win when online.
const C = "tape-v163";
const CORE = ["./", "index.html", "replay.js", "manifest.json", "icon.svg", "icon-192.png", "apple-touch-icon.png", "course.json", "strategy.txt",
  "data/core.json", "data/en.json", "data/insights.json", "data/concepts.json", "data/lessons.json", "data/glossary.json", "data/ideas.json", "data/priceaction.json", "data/practice.json", "data/news.json", "data/study.json", "data/site.json", "data/premium.json", "data/gems.json"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(CORE)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !/^https?:/.test(e.request.url)) return;
  const own = new URL(e.request.url).origin === self.location.origin;
  // own files skip the browser's 10-minute HTTP cache, so a new release shows on the first reload
  e.respondWith((own ? fetch(e.request.url, {cache: "no-cache", credentials: "same-origin"}) : fetch(e.request)).then(r => {
    if (r && (r.ok || r.type === "opaque")){ const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(e.request, {ignoreSearch: true}).then(m => m || Response.error())));
});
