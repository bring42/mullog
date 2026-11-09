/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, prerendered, version } from '$service-worker';
import { PENDING_SHARE_KEY, SHARE_CACHE, SHARE_NAME_HEADER } from '$lib/share';

const sw = self as unknown as ServiceWorkerGlobalScope;

const ASSET_CACHE_PREFIX = 'mullog-assets-';
const ASSET_CACHE = `${ASSET_CACHE_PREFIX}${version}`;
// Hashed build output, static files and the prerendered shell. Nothing user-provided is ever cached here.
const PRECACHE = [...build, ...files, ...prerendered];
// Immutable/static assets are served cache-first; pages stay network-first so deploys show up immediately.
const CACHE_FIRST = new Set([...build, ...files]);

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(ASSET_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        // Only drop old asset caches; the share cache is owned by the page.
        if (key.startsWith(ASSET_CACHE_PREFIX) && key !== ASSET_CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })()
  );
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;

  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(receiveShare(event.request));
    return;
  }

  if (event.request.method !== 'GET') return;

  if (CACHE_FIRST.has(url.pathname)) {
    event.respondWith(cacheFirst(event.request, url.pathname));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstShell(event.request));
  }
});

/** Web Share Target: keep the file on-device and hand it to the page. Never forwards the POST. */
async function receiveShare(request: Request): Promise<Response> {
  const redirect = (state: string) => Response.redirect(new URL(`/?shared=${state}`, sw.location.origin).href, 303);
  try {
    const form = await request.formData();
    const file = form.getAll('file').find((entry): entry is File => entry instanceof File && entry.size > 0);
    let name: string;
    let body: Blob;
    if (file) {
      name = file.name || 'shared.log';
      body = file;
    } else {
      const text = form.get('text');
      if (typeof text !== 'string' || text.length === 0) return redirect('empty');
      name = 'shared.log';
      body = new Blob([text], { type: 'text/plain' });
    }
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(
      PENDING_SHARE_KEY,
      new Response(body, {
        headers: {
          'content-type': 'application/octet-stream',
          [SHARE_NAME_HEADER]: encodeURIComponent(name)
        }
      })
    );
    return redirect('1');
  } catch {
    return redirect('error');
  }
}

async function cacheFirst(request: Request, path: string): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(path);
  return cached ?? fetch(request);
}

async function networkFirstShell(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(ASSET_CACHE);
    const shell = (await cache.match('/')) ?? (await cache.match(new URL(request.url).pathname));
    if (shell) return shell;
    throw new Error('offline and no cached shell');
  }
}
