import zlib from 'zlib';

// body-parser only understands gzip/deflate. Some clients/proxies/webhooks send
// `Content-Encoding: br`, which makes express.json() throw
// "UnsupportedMediaTypeError: unsupported content encoding "br"".
// This middleware (mount before the body parsers) decompresses brotli bodies and
// parses JSON / urlencoded payloads itself, then marks the body as parsed.
export const brotliBody = ({ limit = 50 * 1024 * 1024 } = {}) => (req, res, next) => {
  const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
  if (encoding !== 'br') return next();

  const type = String(req.headers['content-type'] || '').toLowerCase();
  const isJson = type.includes('json');
  const isForm = type.includes('application/x-www-form-urlencoded');
  if (!isJson && !isForm) {
    return res.status(415).json({ success: false, message: 'Unsupported content type for brotli-encoded body' });
  }

  const decoder = zlib.createBrotliDecompress();
  const chunks = [];
  let size = 0;
  let done = false;

  const fail = (status, message) => {
    if (done) return;
    done = true;
    req.unpipe(decoder);
    decoder.destroy();
    if (!res.headersSent) res.status(status).json({ success: false, message });
  };

  decoder.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) return fail(413, 'Request body too large');
    chunks.push(chunk);
  });
  decoder.on('error', () => fail(400, 'Invalid brotli-encoded body'));
  req.on('error', () => fail(400, 'Failed to read request body'));
  decoder.on('end', () => {
    if (done) return;
    done = true;
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      if (isJson) {
        req.body = raw.trim() ? JSON.parse(raw) : {};
      } else {
        req.body = Object.fromEntries(new URLSearchParams(raw));
      }
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid request body' });
    }
    delete req.headers['content-encoding'];
    delete req.headers['content-length'];
    req._body = true; // body-parser skips requests already marked as parsed
    next();
  });

  req.pipe(decoder);
};
