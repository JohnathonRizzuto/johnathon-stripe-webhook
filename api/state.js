// /api/state -- cross-device sync for the Johnathon Builds dashboard.
//
// GET    /api/state   returns the current synced state blob
// POST   /api/state   merges request body (object map) into existing state
// DELETE /api/state   nukes everything (testing only)
//
// Auth: requires X-Send-Key header to match SEND_EMAIL_KEY env var.
// Backed by Redis Cloud via the `redis` (node-redis) npm package.
//
// Written as plain .js (not .ts) to bypass Vercel's TypeScript bundler,
// which was generating an ES-module-flavored output that Node's runtime
// couldn't load. Plain JS = no transpilation = no chance of that bug.

const { createClient } = require("redis");

const STATE_KEY = "jb:dashboard:state";

let cachedClient = null;
let cachedClientReady = null;

async function getRedis() {
  if (cachedClient && cachedClient.isReady) return cachedClient;
  if (cachedClientReady) return cachedClientReady;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL env var not set -- did the Redis integration finish provisioning?");
  }

  cachedClientReady = (async () => {
    const client = createClient({ url });
    client.on("error", (err) => {
      console.error("Redis client error:", err);
    });
    await client.connect();
    cachedClient = client;
    cachedClientReady = null;
    return client;
  })();

  return cachedClientReady;
}

module.exports = async function handler(req, res) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Send-Key");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Shared-secret auth
  const expected = process.env.SEND_EMAIL_KEY;
  const provided = req.headers["x-send-key"];
  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: SEND_EMAIL_KEY not set." });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getRedis();

    if (req.method === "GET") {
      const raw = await redis.get(STATE_KEY);
      const state = raw ? JSON.parse(raw) : {};
      return res.status(200).json({ state, ts: Date.now() });
    }

    if (req.method === "POST") {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Body must be an object map of keys to values." });
      }
      const currentRaw = await redis.get(STATE_KEY);
      const current = currentRaw ? JSON.parse(currentRaw) : {};
      const merged = Object.assign({}, current, body);
      await redis.set(STATE_KEY, JSON.stringify(merged));
      return res.status(200).json({ ok: true, ts: Date.now(), keys: Object.keys(merged) });
    }

    if (req.method === "DELETE") {
      await redis.del(STATE_KEY);
      return res.status(200).json({ ok: true, cleared: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    const msg = err && err.message ? err.message : "Unknown error";
    console.error("state endpoint error:", err);
    return res.status(500).json({ error: msg });
  }
};
