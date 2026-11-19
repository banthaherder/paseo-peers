// Paseo Peers relay: a store-and-forward mailbox for end-to-end encrypted messages.
// Zero dependencies. The relay never sees plaintext: it authenticates senders by their
// Ed25519 key, queues opaque payloads per recipient, and hands them out on long-poll.

import { createServer } from "node:http";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = "1.0.0";
const PORT = Number(process.env.PORT ?? 6767);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const ADMIN_TOKEN = process.env.RELAY_ADMIN_TOKEN ?? "";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 512 * 1024);
const MESSAGE_TTL_MS = Number(process.env.MESSAGE_TTL_DAYS ?? 14) * 86_400_000;
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 2000);
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_WAIT_S = 30;
const SEND_RATE_PER_MIN = Number(process.env.SEND_RATE_PER_MIN ?? 120);

if (ADMIN_TOKEN.length < 16) {
  console.error("RELAY_ADMIN_TOKEN must be set to at least 16 characters.");
  process.exit(1);
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // base64url Ed25519 public key (32 bytes)
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ---------- persistence ----------

const statePath = join(DATA_DIR, "state.json");
const queueRoot = join(DATA_DIR, "queue");
/** @type {{ keys: Record<string, {label: string, addedAt: string, lastSeenAt: string | null}>, invites: Record<string, {label: string, createdAt: string, expiresAt: string}> }} */
let state = { keys: {}, invites: {} };
/** @type {Map<string, Map<string, object>>} recipient key -> (message id -> envelope), insertion ordered */
const queues = new Map();

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}

let saveChain = Promise.resolve();
function saveState() {
  saveChain = saveChain.then(() => writeJsonAtomic(statePath, state)).catch((e) => console.error("state save failed", e));
  return saveChain;
}

const keyDir = (key) => join(queueRoot, Buffer.from(key, "base64url").toString("hex"));

async function load() {
  await mkdir(queueRoot, { recursive: true, mode: 0o700 });
  try {
    state = { keys: {}, invites: {}, ...JSON.parse(await readFile(statePath, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const key of Object.keys(state.keys)) {
    const q = new Map();
    let files = [];
    try {
      files = (await readdir(keyDir(key))).filter((f) => f.endsWith(".json")).sort();
    } catch {}
    for (const file of files) {
      try {
        const env = JSON.parse(await readFile(join(keyDir(key), file), "utf8"));
        q.set(env.id, env);
      } catch {}
    }
    queues.set(key, q);
  }
}

// ---------- auth ----------

const seenSignatures = new Map(); // sig -> expiry
function rememberSignature(sig) {
  const now = Date.now();
  if (seenSignatures.size > 10_000) {
    for (const [s, exp] of seenSignatures) if (exp < now) seenSignatures.delete(s);
  }
  if (seenSignatures.has(sig)) return false;
  seenSignatures.set(sig, now + 2 * CLOCK_SKEW_MS);
  return true;
}

function signedString(method, path, ts, body) {
  const digest = createHash("sha256").update(body).digest("hex");
  return `paseo-peers-relay/v1\n${method}\n${path}\n${ts}\n${digest}`;
}

/** Returns the authenticated Ed25519 key, or throws an HttpError. */
function authenticate(req, path, body) {
  const key = String(req.headers["x-peer-key"] ?? "");
  const ts = String(req.headers["x-peer-ts"] ?? "");
  const sig = String(req.headers["x-peer-sig"] ?? "");
  if (!KEY_RE.test(key) || !/^\d{10,16}$/.test(ts) || !sig) throw new HttpError(401, "missing or malformed signature headers");
  if (Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) throw new HttpError(401, "timestamp outside allowed clock skew");
  let ok = false;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" });
    ok = verify(null, Buffer.from(signedString(req.method, path, ts, body)), publicKey, Buffer.from(sig, "base64url"));
  } catch {}
  if (!ok) throw new HttpError(401, "bad signature");
  if (!rememberSignature(sig)) throw new HttpError(401, "replayed request");
  return key;
}

function isAdmin(req) {
  const header = String(req.headers.authorization ?? "");
  if (!header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(ADMIN_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function requireRegistered(key) {
  if (!state.keys[key]) throw new HttpError(403, "key is not registered with this relay");
  state.keys[key].lastSeenAt = new Date().toISOString();
}

// ---------- long-poll waiters ----------

const waiters = new Map(); // key -> Set<() => void>
function notify(key) {
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const wake of set) wake();
}
function waitFor(key, ms, req) {
  return new Promise((resolve) => {
    const set = waiters.get(key) ?? new Set();
    waiters.set(key, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    req.once("close", done);
  });
}

// ---------- rate limiting ----------

const buckets = new Map(); // key -> {tokens, at}
function takeToken(key) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: SEND_RATE_PER_MIN, at: now };
  b.tokens = Math.min(SEND_RATE_PER_MIN, b.tokens + ((now - b.at) / 60_000) * SEND_RATE_PER_MIN);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

// ---------- handlers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handleInvites(req, body) {
  if (!isAdmin(req)) throw new HttpError(401, "admin token required");
  const input = parseJson(body);
  const ttlHours = Math.min(Math.max(Number(input.ttlHours ?? 168), 1), 24 * 30);
  const invite = randomBytes(18).toString("base64url");
  const createdAt = new Date();
  state.invites[invite] = {
    label: String(input.label ?? "").slice(0, 80),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlHours * 3_600_000).toISOString(),
  };
  await saveState();
  return { invite, expiresAt: state.invites[invite].expiresAt };
}

async function handleRegister(req, key, body) {
  const input = parseJson(body);
  const label = String(input.label ?? "").slice(0, 80);
  if (req.headers.authorization && !isAdmin(req)) throw new HttpError(401, "admin token rejected");
  if (state.keys[key]) return { registered: true, already: true };
  if (!isAdmin(req)) {
    const invite = String(input.invite ?? "");
    const record = state.invites[invite];
    if (!record) throw new HttpError(403, "unknown or already used invite");
    delete state.invites[invite];
    if (Date.parse(record.expiresAt) < Date.now()) {
      await saveState();
      throw new HttpError(403, "invite expired");
    }
  }
  state.keys[key] = { label, addedAt: new Date().toISOString(), lastSeenAt: null };
  queues.set(key, new Map());
  await mkdir(keyDir(key), { recursive: true, mode: 0o700 });
  await saveState();
  console.log(`registered key ${key.slice(0, 8)}… (${label || "no label"})`);
  return { registered: true, already: false };
}

async function handleSend(key, body) {
  requireRegistered(key);
  if (!takeToken(key)) throw new HttpError(429, "rate limited");
  const input = parseJson(body);
  const to = String(input.to ?? "");
  const id = String(input.id ?? "");
  if (!KEY_RE.test(to)) throw new HttpError(400, "bad recipient");
  if (!ID_RE.test(id)) throw new HttpError(400, "bad message id");
  if (typeof input.payload !== "object" || input.payload === null) throw new HttpError(400, "payload must be an object");
  if (!state.keys[to]) throw new HttpError(404, "recipient is not registered with this relay");
  const q = queues.get(to);
  if (q.has(id)) return { queued: true, duplicate: true };
  if (q.size >= MAX_QUEUE) throw new HttpError(507, "recipient queue is full");
  const env = { id, from: key, to, receivedAt: new Date().toISOString(), payload: input.payload };
  await writeJsonAtomic(join(keyDir(to), `${Date.now().toString().padStart(15, "0")}-${id}.json`), env);
  q.set(id, env);
  notify(to);
  return { queued: true, duplicate: false };
}

async function removeEnvelopes(key, ids) {
  const q = queues.get(key);
  if (!q || ids.length === 0) return;
  const wanted = new Set(ids.filter((id) => typeof id === "string"));
  let files = [];
  try {
    files = await readdir(keyDir(key));
  } catch {}
  for (const file of files) {
    const id = file.replace(/^\d+-/, "").replace(/\.json$/, "");
    if (wanted.has(id)) await rm(join(keyDir(key), file), { force: true });
  }
  for (const id of wanted) q.delete(id);
}

async function handlePoll(req, key, body) {
  requireRegistered(key);
  const input = parseJson(body);
  await removeEnvelopes(key, Array.isArray(input.ack) ? input.ack.slice(0, 500) : []);
  const wait = Math.min(Math.max(Number(input.wait ?? 0), 0), MAX_WAIT_S);
  const q = queues.get(key);
  if (q.size === 0 && wait > 0) await waitFor(key, wait * 1000, req);
  return { messages: [...q.values()].slice(0, 50) };
}

function parseJson(body) {
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const send = (status, value) => {
    if (res.headersSent || res.destroyed) return;
    const json = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.end(json);
  };
  try {
    if (req.method === "GET" && (path === "/v1/health" || path === "/")) {
      return send(200, { ok: true, service: "paseo-peers-relay", version: VERSION });
    }
    if (req.method !== "POST") throw new HttpError(404, "not found");
    const body = await readBody(req);
    if (path === "/v1/invites") return send(200, await handleInvites(req, body));
    const key = authenticate(req, path, body);
    if (path === "/v1/register") return send(200, await handleRegister(req, key, body));
    if (path === "/v1/send") return send(200, await handleSend(key, body));
    if (path === "/v1/poll") return send(200, await handlePoll(req, key, body));
    throw new HttpError(404, "not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    send(status, { error: error instanceof HttpError ? error.message : "internal error" });
  }
});

async function expireOldMessages() {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  for (const [key, q] of queues) {
    const stale = [...q.values()].filter((env) => Date.parse(env.receivedAt) < cutoff).map((env) => env.id);
    if (stale.length) await removeEnvelopes(key, stale);
  }
  let changed = false;
  for (const [invite, record] of Object.entries(state.invites)) {
    if (Date.parse(record.expiresAt) < Date.now()) {
      delete state.invites[invite];
      changed = true;
    }
  }
  if (changed) await saveState();
}

await load();
setInterval(() => void expireOldMessages().catch((e) => console.error("expiry failed", e)), 3_600_000).unref();
server.requestTimeout = (MAX_WAIT_S + 15) * 1000;
server.listen(PORT, HOST, () => {
  console.log(`paseo-peers-relay ${VERSION} listening on ${HOST}:${PORT} (data: ${DATA_DIR}, keys: ${Object.keys(state.keys).length})`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    for (const key of [...waiters.keys()]) notify(key);
    saveChain.finally(() => process.exit(0));
  });
}
