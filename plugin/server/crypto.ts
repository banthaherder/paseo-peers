// Identity keys and end-to-end message encryption, using only node:crypto so the plugin runs
// inside Paseo's Electron runtime (BoringSSL: no ChaCha20, so AES-256-GCM).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

export interface Identity {
  /** Ed25519 public key, base64url. This is the peer's address on the relay. */
  signPub: string;
  signPrivJwk: JsonWebKey;
  /** X25519 public key, base64url. Used for encryption. */
  boxPub: string;
  boxPrivJwk: JsonWebKey;
  createdAt: string;
}

export function createIdentity(): Identity {
  const signing = generateKeyPairSync("ed25519");
  const box = generateKeyPairSync("x25519");
  return {
    signPub: signing.publicKey.export({ format: "jwk" }).x as string,
    signPrivJwk: signing.privateKey.export({ format: "jwk" }),
    boxPub: box.publicKey.export({ format: "jwk" }).x as string,
    boxPrivJwk: box.privateKey.export({ format: "jwk" }),
    createdAt: new Date().toISOString(),
  };
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const isPublicKey = (value: unknown): value is string => typeof value === "string" && KEY_RE.test(value);

const privateKeys = new WeakMap<JsonWebKey, KeyObject>();
function privateKey(jwk: JsonWebKey): KeyObject {
  let key = privateKeys.get(jwk);
  if (!key) {
    key = createPrivateKey({ key: jwk, format: "jwk" });
    privateKeys.set(jwk, key);
  }
  return key;
}
const edPublic = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
const xPublic = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });

export function signBytes(identity: Identity, data: Buffer | string): string {
  return sign(null, Buffer.from(data), privateKey(identity.signPrivJwk)).toString("base64url");
}

export function verifyBytes(signPub: string, data: Buffer | string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(data), edPublic(signPub), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Short human-checkable fingerprint of an identity key, e.g. "3F9A-12CC-7B04". */
export function fingerprint(signPub: string): string {
  const hex = createHash("sha256").update(Buffer.from(signPub, "base64url")).digest("hex").slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Encrypted payload as stored on the relay. Everything except `ct` is visible to the relay. */
export interface SealedPayload {
  v: 1;
  /** Sender's X25519 key, so a first-contact "hello" can be opened before the peer is known. */
  boxPub: string;
  nonce: string;
  ct: string;
  /** Ed25519 signature by the sender over the header and ciphertext. */
  sig: string;
}

function sessionKey(identity: Identity, mySignPub: string, peerSignPub: string, peerBoxPub: string): Buffer {
  const shared = diffieHellman({ privateKey: privateKey(identity.boxPrivJwk), publicKey: xPublic(peerBoxPub) });
  const salt = createHash("sha256").update([mySignPub, peerSignPub].sort().join(".")).digest();
  return Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from("paseo-peers/v1/aes-256-gcm"), 32));
}

const sealedHeader = (id: string, from: string, to: string, boxPub: string, nonce: string) =>
  `paseo-peers/v1|${id}|${from}|${to}|${boxPub}|${nonce}`;

export function seal(identity: Identity, input: { id: string; to: string; toBoxPub: string; plaintext: unknown }): SealedPayload {
  const key = sessionKey(identity, identity.signPub, input.to, input.toBoxPub);
  const nonce = randomBytes(12);
  const nonceText = nonce.toString("base64url");
  const header = sealedHeader(input.id, identity.signPub, input.to, identity.boxPub, nonceText);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(header));
  const body = Buffer.concat([cipher.update(JSON.stringify(input.plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const ct = body.toString("base64url");
  return { v: 1, boxPub: identity.boxPub, nonce: nonceText, ct, sig: signBytes(identity, `${header}|${ct}`) };
}

/**
 * Verifies and decrypts a payload from `from`. `expectedBoxPub` is the peer's known X25519 key;
 * pass null only for first contact, where the payload's own key is used and the caller must
 * authorize the sender from the decrypted content (an invite token).
 */
export function open(
  identity: Identity,
  input: { id: string; from: string; payload: SealedPayload; expectedBoxPub: string | null },
): unknown {
  const { payload } = input;
  if (payload?.v !== 1 || !isPublicKey(payload.boxPub) || typeof payload.nonce !== "string" || typeof payload.ct !== "string") {
    throw new Error("malformed payload");
  }
  if (input.expectedBoxPub && payload.boxPub !== input.expectedBoxPub) throw new Error("sender encryption key changed");
  const header = sealedHeader(input.id, input.from, identity.signPub, payload.boxPub, payload.nonce);
  if (!verifyBytes(input.from, `${header}|${payload.ct}`, payload.sig)) throw new Error("bad sender signature");
  const key = sessionKey(identity, identity.signPub, input.from, payload.boxPub);
  const body = Buffer.from(payload.ct, "base64url");
  if (body.length < 17) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.nonce, "base64url"), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(header));
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/** Signs a relay HTTP request. Must match the relay's `signedString`. */
export function relayAuthHeaders(identity: Identity, method: string, path: string, body: string): Record<string, string> {
  const ts = String(Date.now());
  const digest = createHash("sha256").update(body).digest("hex");
  const sig = signBytes(identity, `paseo-peers-relay/v1\n${method}\n${path}\n${ts}\n${digest}`);
  return { "x-peer-key": identity.signPub, "x-peer-ts": ts, "x-peer-sig": sig };
}

export const newId = () => randomBytes(12).toString("base64url");
