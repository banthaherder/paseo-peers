import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIdentity, type Identity } from "./crypto";

export interface StoredPeer {
  id: string; // Ed25519 public key
  name: string;
  boxPub: string;
  addedAt: string;
  autoDeliverAgentId: string | null;
  autoDeliverAgentTitle: string | null;
}

export interface StoredMessage {
  id: string;
  peerId: string;
  direction: "in" | "out";
  text: string;
  sentAt: string;
  via: "human" | "agent";
  agentTitle: string | null;
  status: "unread" | "read" | "queued" | "delivered" | "dismissed" | "pending" | "sent" | "failed";
  deliveredTo: { agentId: string | null; agentTitle: string | null } | null;
  error: string | null;
}

export interface StoredInvite {
  id: string;
  token: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

/** Encrypted envelope waiting to be posted to the relay. */
export interface OutboxItem {
  id: string;
  to: string;
  payload: unknown;
  /** Local message this envelope carries, if any (receipts and handshakes have none). */
  messageId: string | null;
  attempts: number;
  createdAt: string;
}

export interface StoredState {
  version: 1;
  identity: Identity;
  profile: { name: string };
  relay: { url: string | null; adminToken: string | null; registeredUrl: string | null };
  agentTools: "all" | "off";
  peers: StoredPeer[];
  messages: StoredMessage[];
  invites: StoredInvite[];
  outbox: OutboxItem[];
  /** Inbound envelope ids already processed, so relay redelivery is harmless. */
  seen: string[];
}

const MAX_MESSAGES = 1000;
const MAX_SEEN = 2000;

export function dataDir(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-peers");
}

export class Store {
  private chain: Promise<void> = Promise.resolve();
  private constructor(
    private readonly path: string,
    public state: StoredState,
  ) {}

  static async open(dir = dataDir()): Promise<Store> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "state.json");
    let state: StoredState;
    try {
      state = JSON.parse(await readFile(path, "utf8")) as StoredState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = {
        version: 1,
        identity: createIdentity(),
        profile: { name: "" },
        relay: { url: null, adminToken: null, registeredUrl: null },
        agentTools: "all",
        peers: [],
        messages: [],
        invites: [],
        outbox: [],
        seen: [],
      };
    }
    const store = new Store(path, state);
    await store.save();
    return store;
  }

  /** Serializes writes; each call persists the state as it is when the write runs. */
  save(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const s = this.state;
      if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
      if (s.seen.length > MAX_SEEN) s.seen = s.seen.slice(-MAX_SEEN);
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    return this.chain;
  }

  peer(id: string): StoredPeer | undefined {
    return this.state.peers.find((p) => p.id === id);
  }

  message(id: string): StoredMessage | undefined {
    return this.state.messages.find((m) => m.id === id);
  }
}
