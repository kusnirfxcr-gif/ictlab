// Offline cache for Tape. Network first, cache as fallback, so new versions always win when online.
const C = "tape-v30";
const CORE = ["./", "index.html", "manifest.json", "icon.svg", "course.json", "strategy.txt",
  "data/core.json", "data/insights.json", "data/concepts.json", "data/lessons.json", "data/glossary.json", "data/ideas.json", "data/priceaction.json", "data/practice.json", "data/news.json", "data/study.json", "data/site.json", "data/premium.json"];
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(CORE)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !/^https?:/.test(e.request.url)) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r && (r.ok || r.type === "opaque")){ const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)).catch(() => {}); }
    return r;
  }).catch(() => caches.match(e.request, {ignoreSearch: true}).then(m => m || Response.error())));
});
