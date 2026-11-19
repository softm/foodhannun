const CACHE_NAME='hannun-pwa-shell-20261119';
const ROOT='./';
const isRuntimeData=url=>url.pathname.includes('/data/')||url.pathname.includes('/api/')||url.pathname.includes('/auth/')||/\.(?:json|csv|gz|zip)(?:$|\?)/i.test(url.href);
const sameOriginStatic=value=>{try{const url=new URL(value,self.location.href);return url.origin===self.location.origin&&!isRuntimeData(url);}catch{return false;}};

self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll([ROOT])).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('hannun-pwa-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{
 if(event.data?.type!=='PRECACHE_URLS'||!Array.isArray(event.data.urls))return;
 const urls=[...new Set(event.data.urls)].filter(sameOriginStatic).slice(0,300);
 event.waitUntil(caches.open(CACHE_NAME).then(cache=>Promise.allSettled(urls.map(url=>cache.add(url)))));
});
self.addEventListener('fetch',event=>{
 const request=event.request;if(request.method!=='GET')return;
 const url=new URL(request.url);if(url.origin!==self.location.origin||isRuntimeData(url))return;
 if(request.mode==='navigate'){
  event.respondWith(fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(ROOT,response.clone()));return response;}).catch(()=>caches.match(request).then(hit=>hit||caches.match(ROOT))));return;
 }
 event.respondWith(caches.match(request).then(cached=>{const refresh=fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response;});if(cached){refresh.catch(()=>{});return cached;}return refresh;}));
});
