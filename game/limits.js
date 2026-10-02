// Per-client limits that protect the single server instance from floods:
// who a request comes from, token buckets and an HTTP request limiter.

// The client's address, as a key for limits (never shown to anyone).
//
// In production the server sits behind Render's Cloudflare edge. Cloudflare
// always overwrites CF-Connecting-IP with the address it was connected from, so
// a client can't fake it. X-Forwarded-For is only a fallback: Render appends to
// whatever the client sent, so its first entry can be forged. Forging it can
// only escape the limits, never lock someone else out, so the fallback fails
// open. Without either header (local runs, tests) the socket address is used.
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const cf = headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return { ip: ipKey(cf), source: "cf-connecting-ip" };
  const xff = headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return { ip: ipKey(xff.split(",")[0]), source: "x-forwarded-for" };
  return { ip: ipKey((req && req.socket && req.socket.remoteAddress) || "unknown"), source: "socket" };
}

// Normalizes an address into a limit key. IPv4-mapped IPv6 becomes plain IPv4.
// IPv6 is keyed by its /64 prefix: one connection usually owns a whole /64, so
// keying by full address would let a client rotate addresses past every limit.
function ipKey(raw) {
  let ip = String(raw).trim().slice(0, 64).toLowerCase();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  if (!ip.includes(":")) return ip;
  ip = ip.split("%")[0];
  const [head, tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = ip.includes("::") && tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const parts = ip.includes("::") ? [...headParts, ...Array(missing).fill("0"), ...tailParts] : headParts;
  return `${parts.slice(0, 4).map((p) => p.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// A token bucket: `capacity` actions at once, refilled at `refillPerSec`.
function createBucket({ capacity, refillPerSec }) {
  const bucket = { tokens: capacity, last: Date.now() };
  return function take() {
    const now = Date.now();
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.last) / 1000) * refillPerSec);
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  };
}

// Express middleware: at most `max` requests per client per `windowMs`.
// Returns the middleware plus a stop() for its cleanup timer.
function createHttpLimiter({ max, windowMs, keyOf }) {
  let counts = new Map();
  const timer = setInterval(() => { counts = new Map(); }, windowMs);
  timer.unref();
  function middleware(req, res, next) {
    if (!max) return next();
    const key = keyOf(req);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  }
  return { middleware, stop: () => clearInterval(timer) };
}

module.exports = { clientIp, ipKey, createBucket, createHttpLimiter };
