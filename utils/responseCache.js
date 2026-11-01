/**
 * Small in-memory response cache for PUBLIC, read-mostly GET endpoints (same body for every caller).
 *
 *   router.get('/list', cacheGet({ ttlSeconds: 60, tag: 'swapna' }), handler);
 *
 * - Key = full URL incl. query string (so clientId / lang / filters never mix).
 * - Only 200 responses are stored. Never put this on an endpoint that depends on who is logged in.
 * - Writes clear their tag immediately via invalidateCacheOnWrite() (mounted once in app.js); the TTL
 *   bounds staleness for anything else (e.g. other server instances, since this cache is per process).
 * - Browsers still revalidate (ETag -> 304), so the payload is skipped when nothing changed.
 */

const MAX_ENTRIES = 500;
const MAX_BODY_BYTES = 1024 * 1024; // don't hold huge payloads in memory

const store = new Map(); // url -> { body, tag, expires }

const evictIfFull = () => {
  while (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
};

// tag '*' clears everything (used for broad admin/client write areas that may touch any content)
export const invalidateTag = (tag) => {
  if (tag === '*') return store.clear();
  for (const [key, entry] of store) {
    if (entry.tag === tag) store.delete(key);
  }
};

// perUser: for authenticated lists whose content depends on who is asking (scoped by client / user). Place it AFTER
// the auth middleware so req.user exists; the key then includes the caller, so one account never sees another's data.
export const cacheGet = ({ ttlSeconds = 60, tag, perUser = false }) => (req, res, next) => {
  if (req.method !== 'GET') return next();
  if (perUser && !req.user?._id) return next();

  const key = perUser ? `${req.user.role}:${req.user._id}|${req.originalUrl}` : req.originalUrl;
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) {
    res.set({ 'X-Cache': 'HIT', 'Cache-Control': 'public, max-age=0, must-revalidate' });
    return res.type('json').send(hit.body);
  }

  const sendJson = res.json.bind(res);
  res.json = (payload) => {
    if (res.statusCode === 200) {
      const body = JSON.stringify(payload);
      if (body.length <= MAX_BODY_BYTES) {
        evictIfFull();
        store.set(key, { body, tag, expires: Date.now() + ttlSeconds * 1000 });
      }
    }
    res.set({ 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=0, must-revalidate' });
    return sendJson(payload);
  };
  next();
};

/**
 * Clears a tag after any successful write under a URL prefix, e.g.
 *   app.use(invalidateCacheOnWrite({ '/api/swapna-decoder': 'swapna' }));
 */
export const invalidateCacheOnWrite = (prefixToTag) => (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    for (const [prefix, tag] of Object.entries(prefixToTag)) {
      if (req.originalUrl.startsWith(prefix)) invalidateTag(tag);
    }
  });
  next();
};
