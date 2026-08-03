'use strict';
const CACHE='classic-mart-public-v17';
const STATIC=['/offline','/styles.css','/pwa.js','/assets/pwa-icon.svg','/assets/pwa-192.png','/assets/pwa-512.png','/assets/product-placeholder.svg','/assets/products/wireless-headphones.svg','/assets/products/city-backpack.svg','/assets/products/smart-watch.svg','/assets/products/table-lamp.svg'];
const PRIVATE_PREFIXES=['/api/','/account','/dashboard','/cart','/checkout','/track-order','/payments','/admin','/seller','/promoter','/delivery','/operations','/business','/ask-classic','/webhooks','/login','/signup','/verify-','/onboarding'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
function isPrivate(path){return PRIVATE_PREFIXES.some(prefix=>path.startsWith(prefix));}
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;
  const url=new URL(request.url);if(url.origin!==self.location.origin)return;
  if(isPrivate(url.pathname)){event.respondWith(fetch(request,{cache:'no-store'}));return;}
  if(request.mode==='navigate'){
    event.respondWith(fetch(request,{cache:'no-store'}).catch(()=>caches.match('/offline')));return;
  }
  if(url.pathname.startsWith('/assets/')||url.pathname.startsWith('/dashboard-assets/')||['/styles.css','/script.js','/pwa.js'].includes(url.pathname)){
    event.respondWith(caches.match(request).then(hit=>hit||fetch(request).then(response=>{if(response.ok){const clone=response.clone();caches.open(CACHE).then(cache=>cache.put(request,clone));}return response;})));return;
  }
  if(url.pathname.startsWith('/media/catalogue/')){
    event.respondWith(caches.match(request).then(hit=>{const network=fetch(request).then(response=>{if(response.ok){const clone=response.clone();caches.open(CACHE).then(cache=>cache.put(request,clone));}return response;}).catch(()=>hit);return hit||network;}));return;
  }
  event.respondWith(fetch(request));
});
self.addEventListener('push',event=>{let data={};try{data=event.data?.json()||{};}catch{data={body:event.data?.text()||'Classic Mart update'};}const title=String(data.title||'Classic Mart');const options={body:String(data.body||''),icon:'/assets/pwa-icon.svg',badge:'/assets/pwa-icon.svg',data:{url:String(data.deepLink||'/dashboard')},tag:String(data.tag||'classic-mart-update')};event.waitUntil(self.registration.showNotification(title,options));});
self.addEventListener('notificationclick',event=>{event.notification.close();const target=event.notification.data?.url||'/dashboard';event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{for(const client of clients){if('focus'in client){client.navigate(target);return client.focus();}}return self.clients.openWindow(target);}));});
