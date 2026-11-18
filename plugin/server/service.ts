import type { PluginHandlerContext } from "@getpaseo/plugin/server";
type PaseoApi = PluginHandlerContext["paseo"];
import { z } from "zod";
import type { AgentSummary, PeersState, RelayStatus } from "../shared/contracts";
import { fingerprint, isPublicKey, newId, open, seal } from "./crypto";
import { normalizeRelayUrl, RelayClient, RelayError, type RelayEnvelope } from "./relay-client";
import type { OutboxItem, StoredMessage, StoredPeer, Store } from "./store";

const INVITE_PREFIX = "paseo-peer:";
const POLL_WAIT_SECONDS = 25;
const QUEUED_DELIVERY_MAX_MS = 12 * 3_600_000;

const plaintextSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    text: z.string().max(64_000),
    sentAt: z.string(),
    via: z.enum(["human", "agent"]),
    agentTitle: z.string().max(200).nullable(),
  }),
  z.object({
    type: z.literal("receipt"),
    messageId: z.string(),
    status: z.enum(["read", "queued", "delivered", "dismissed"]),
    agentTitle: z.string().max(200).nullable(),
  }),
  z.object({ type: z.literal("hello"), invite: z.string(), name: z.string().min(1).max(60) }),
  z.object({ type: z.literal("hello-ack"), name: z.string().min(1).max(60) }),
]);
type Plaintext = z.infer<typeof plaintextSchema>;

const inviteCodeSchema = z.object({
  v: z.literal(1),
  r: z.string(),
  t: z.string().min(8),
  n: z.string().min(1).max(60),
  k: z.string().refine(isPublicKey),
  b: z.string().refine(isPublicKey),
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

type AgentRecord = {
  id: string;
  title?: string | null;
  status?: string | null;
  cwd?: string | null;
  provider?: string | null;
  archivedAt?: string | null;
  background?: boolean | null;
};

export class PeerService {
  private readonly listeners = new Set<(state: PeersState) => void>();
  private relayStatus: RelayStatus = "unconfigured";
  private lastError: string | null = null;
  private lastOkAt: string | null = null;
  private stopped = false;
  private pollAbort = new AbortController();
  private acks: string[] = [];
  private flushing = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly queuedDeliveries = new Set<string>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  private paseo: PaseoApi | null = null;

  constructor(private readonly store: Store) {}

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    void this.pollLoop();
    void this.flush();
  }

  /**
   * Plugins only get a Paseo API inside handler and hook contexts, so the first one to arrive is
   * kept. Deliveries that were waiting on it (queued, or auto-delivered while detached) resume.
   */
  attach(paseo: PaseoApi): void {
    if (this.paseo || this.stopped) return;
    this.paseo = paseo;
    for (const message of this.store.state.messages) {
      if (message.direction !== "in") continue;
      if (message.status === "queued" && message.deliveredTo?.agentId) {
        void this.waitThenDeliver(message.id, message.deliveredTo.agentId);
      } else if (message.status === "unread") {
        this.autoDeliver(message);
      }
    }
  }

  private api(): PaseoApi {
    if (!this.paseo) throw new Error("Paseo isn't connected to the plugin yet. Try again in a moment.");
    return this.paseo;
  }

  private autoDeliver(message: StoredMessage): void {
    const peer = this.store.peer(message.peerId);
    if (!peer?.autoDeliverAgentId || !this.paseo) return;
    void this.deliver(message.id, peer.autoDeliverAgentId).catch((error) => {
      message.error = `Auto-delivery failed: ${(error as Error).message}`;
      this.changed();
    });
  }

  stop(): void {
    this.stopped = true;
    this.pollAbort.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }

  subscribe(listener: (state: PeersState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    void this.store.save().catch((error) => console.error("[paseo-peers] save failed", error));
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const state = this.publicState();
      for (const listener of this.listeners) listener(state);
    }, 50);
  }

  // ---------------------------------------------------------------- state

  get agentToolsEnabled(): boolean {
    return this.store.state.agentTools === "all" && Boolean(this.store.state.relay.url);
  }

  private get registered(): boolean {
    const { relay } = this.store.state;
    return Boolean(relay.url && relay.registeredUrl === relay.url);
  }

  private relay(): RelayClient | null {
    const { url } = this.store.state.relay;
    return url ? new RelayClient(url, this.store.state.identity) : null;
  }

  publicState(): PeersState {
    const s = this.store.state;
    const peers = s.peers.map((peer) => {
      const messages = s.messages.filter((m) => m.peerId === peer.id);
      return {
        id: peer.id,
        name: peer.name,
        fingerprint: fingerprint(peer.id),
        addedAt: peer.addedAt,
        autoDeliverAgentId: peer.autoDeliverAgentId,
        autoDeliverAgentTitle: peer.autoDeliverAgentTitle,
        lastMessageAt: messages.at(-1)?.sentAt ?? null,
        unread: messages.filter((m) => m.direction === "in" && m.status === "unread").length,
      };
    });
    const now = Date.now();
    return {
      configured: Boolean(s.profile.name && s.relay.url),
      profile: { name: s.profile.name },
      identity: { signPub: s.identity.signPub, fingerprint: fingerprint(s.identity.signPub) },
      relay: {
        url: s.relay.url,
        hasAdminToken: Boolean(s.relay.adminToken),
        registered: this.registered,
        status: this.relayStatus,
        lastError: this.lastError,
        lastOkAt: this.lastOkAt,
      },
      agentTools: s.agentTools,
      peers,
      messages: s.messages.slice(-500).map((m) => ({ ...m })),
      invites: s.invites
        .filter((i) => Date.parse(i.expiresAt) > now)
        .map(({ id, label, createdAt, expiresAt }) => ({ id, label, createdAt, expiresAt })),
      unreadTotal: peers.reduce((sum, p) => sum + p.unread, 0),
    };
  }

  // ---------------------------------------------------------------- configuration

  async configure(input: { name?: string; relayUrl?: string; adminToken?: string }): Promise<PeersState> {
    const s = this.store.state;
    if (input.name !== undefined) s.profile.name = input.name;
    if (input.adminToken !== undefined) s.relay.adminToken = input.adminToken || null;
    if (input.relayUrl !== undefined) {
      const url = input.relayUrl ? normalizeRelayUrl(input.relayUrl) : null;
      if (url && url !== s.relay.url) await new RelayClient(url, s.identity).health();
      if (url !== s.relay.url) s.relay.registeredUrl = null;
      s.relay.url = url;
    }
    if (s.relay.url && s.relay.adminToken && !this.registered) {
      const relay = this.relay()!;
      await relay.register({ adminToken: s.relay.adminToken, label: s.profile.name || "owner" });
      s.relay.registeredUrl = s.relay.url;
    }
    this.restartPolling();
    this.changed();
    return this.publicState();
  }

  setAgentTools(mode: "all" | "off"): void {
    this.store.state.agentTools = mode;
    this.changed();
  }

  // ---------------------------------------------------------------- pairing

  async createInvite(label: string | undefined): Promise<{ code: string; expiresAt: string }> {
    const s = this.store.state;
    if (!s.profile.name) throw new Error("Set your display name first.");
    if (!s.relay.url) throw new Error("Set the relay URL first.");
    if (!s.relay.adminToken) throw new Error("Only the relay owner can create invites. Add the relay admin token in Peers settings.");
    const relay = this.relay()!;
    if (!this.registered) {
      await relay.register({ adminToken: s.relay.adminToken, label: s.profile.name });
      s.relay.registeredUrl = s.relay.url;
    }
    const { invite, expiresAt } = await relay.createInvite(s.relay.adminToken, label ?? "");
    s.invites.push({ id: newId(), token: invite, label: label ?? "", createdAt: new Date().toISOString(), expiresAt });
    this.changed();
    const code = { v: 1, r: s.relay.url, t: invite, n: s.profile.name, k: s.identity.signPub, b: s.identity.boxPub };
    return { code: INVITE_PREFIX + Buffer.from(JSON.stringify(code)).toString("base64url"), expiresAt };
  }

  cancelInvite(inviteId: string): void {
    this.store.state.invites = this.store.state.invites.filter((i) => i.id !== inviteId);
    this.changed();
  }

  async acceptInvite(rawCode: string, name: string | undefined): Promise<{ peerId: string; peerName: string }> {
    const s = this.store.state;
    const trimmed = rawCode.trim().replace(/\s+/g, "");
    if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error("That isn't a Paseo Peers invite code (it should start with paseo-peer:).");
    let code: z.infer<typeof inviteCodeSchema>;
    try {
      code = inviteCodeSchema.parse(JSON.parse(Buffer.from(trimmed.slice(INVITE_PREFIX.length), "base64url").toString("utf8")));
    } catch {
      throw new Error("The invite code is damaged. Ask for a new one.");
    }
    if (code.k === s.identity.signPub) throw new Error("That's your own invite. Send it to the person you want to pair with.");
    if (name) s.profile.name = name;
    if (!s.profile.name) throw new Error("Set your display name first.");
    const relayUrl = normalizeRelayUrl(code.r);
    if (s.relay.url && s.relay.url !== relayUrl && s.peers.length > 0) {
      throw new Error(`You're already paired through ${s.relay.url}; this invite uses ${relayUrl}. One relay per install for now.`);
    }
    if (s.relay.url !== relayUrl) {
      s.relay.url = relayUrl;
      s.relay.registeredUrl = null;
    }
    const relay = this.relay()!;
    await relay.health();
    await relay.register({ invite: code.t, label: s.profile.name });
    s.relay.registeredUrl = relayUrl;
    this.upsertPeer({ id: code.k, name: code.n, boxPub: code.b });
    this.enqueue(code.k, code.b, { type: "hello", invite: code.t, name: s.profile.name }, null);
    this.restartPolling();
    this.changed();
    return { peerId: code.k, peerName: code.n };
  }

  private upsertPeer(input: { id: string; name: string; boxPub: string }): StoredPeer {
    const s = this.store.state;
    let peer = s.peers.find((p) => p.id === input.id);
    if (peer) {
      peer.name = input.name;
      peer.boxPub = input.boxPub;
    } else {
      peer = { ...input, addedAt: new Date().toISOString(), autoDeliverAgentId: null, autoDeliverAgentTitle: null };
      s.peers.push(peer);
    }
    return peer;
  }

  updatePeer(input: { peerId: string; name?: string; autoDeliverAgentId?: string | null }, agentTitle?: string | null): void {
    const peer = this.requirePeer(input.peerId);
    if (input.name) peer.name = input.name;
    if (input.autoDeliverAgentId !== undefined) {
      peer.autoDeliverAgentId = input.autoDeliverAgentId;
      peer.autoDeliverAgentTitle = input.autoDeliverAgentId ? (agentTitle ?? null) : null;
    }
    this.changed();
  }

  removePeer(peerId: string): void {
    const s = this.store.state;
    s.peers = s.peers.filter((p) => p.id !== peerId);
    s.messages = s.messages.filter((m) => m.peerId !== peerId);
    s.outbox = s.outbox.filter((o) => o.to !== peerId);
    this.changed();
  }

  private requirePeer(peerId: string): StoredPeer {
    const peer = this.store.peer(peerId);
    if (!peer) throw new Error("Unknown peer.");
    return peer;
  }

  findPeerByName(name: string): StoredPeer | undefined {
    const wanted = name.trim().toLowerCase();
    const peers = this.store.state.peers;
    return (
      peers.find((p) => p.name.toLowerCase() === wanted) ??
      peers.find((p) => p.id === name.trim()) ??
      (() => {
        const matches = peers.filter((p) => p.name.toLowerCase().startsWith(wanted));
        return matches.length === 1 ? matches[0] : undefined;
      })()
    );
  }

  /** Splits "/peer" arguments into a known peer and the rest, matching multi-word names. */
  parsePeerArgs(args: string): { peer: StoredPeer; text: string } {
    const trimmed = args.trim();
    const peers = [...this.store.state.peers].sort((a, b) => b.name.length - a.name.length);
    for (const peer of peers) {
      const lower = trimmed.toLowerCase();
      const name = peer.name.toLowerCase();
      if (lower === name || lower.startsWith(`${name} `) || lower.startsWith(`${name}:`)) {
        return { peer, text: trimmed.slice(peer.name.length).replace(/^[:\s]+/, "") };
      }
    }
    const [first = "", ...rest] = trimmed.split(/\s+/);
    const peer = first ? this.findPeerByName(first.replace(/:$/, "")) : undefined;
    if (!peer) {
      const names = this.store.state.peers.map((p) => p.name).join(", ") || "none yet";
      throw new Error(`No peer named "${first}". Paired peers: ${names}.`);
    }
    return { peer, text: rest.join(" ") };
  }

  // ---------------------------------------------------------------- sending

  sendMessage(peerId: string, text: string, via: "human" | "agent" = "human", agentTitle: string | null = null): StoredMessage {
    const peer = this.requirePeer(peerId);
    const message: StoredMessage = {
      id: newId(),
      peerId,
      direction: "out",
      text,
      sentAt: new Date().toISOString(),
      via,
      agentTitle,
      status: "pending",
      deliveredTo: null,
      error: null,
    };
    this.store.state.messages.push(message);
    this.enqueue(
      peer.id,
      peer.boxPub,
      { type: "message", text, sentAt: message.sentAt, via, agentTitle },
      message.id,
      message.id,
    );
    return message;
  }

  retry(messageId: string): void {
    const message = this.store.message(messageId);
    if (!message || message.direction !== "out" || message.status !== "failed") return;
    const peer = this.requirePeer(message.peerId);
    message.status = "pending";
    message.error = null;
    this.enqueue(
      peer.id,
      peer.boxPub,
      { type: "message", text: message.text, sentAt: message.sentAt, via: message.via, agentTitle: message.agentTitle },
      message.id,
      message.id,
    );
  }

  private enqueue(to: string, toBoxPub: string, plaintext: Plaintext, messageId: string | null, envelopeId = newId()): void {
    const payload = seal(this.store.state.identity, { id: envelopeId, to, toBoxPub, plaintext });
    const item: OutboxItem = { id: envelopeId, to, payload, messageId, attempts: 0, createdAt: new Date().toISOString() };
    this.store.state.outbox.push(item);
    this.changed();
    void this.flush();
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, ms);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;
    const relay = this.relay();
    if (!relay || !this.registered || this.store.state.outbox.length === 0) return;
    this.flushing = true;
    try {
      while (this.store.state.outbox.length > 0 && !this.stopped) {
        const item = this.store.state.outbox[0];
        const message = item.messageId ? this.store.message(item.messageId) : undefined;
        try {
          await relay.send(item.to, item.id, item.payload as never);
          this.store.state.outbox.shift();
          if (message?.status === "pending") message.status = "sent";
          this.changed();
        } catch (error) {
          const relayError = error instanceof RelayError ? error : new RelayError(String(error), null);
          if (relayError.transient) {
            item.attempts += 1;
            this.changed();
            this.scheduleFlush(Math.min(60_000, 2000 * 2 ** Math.min(item.attempts, 5)));
            return;
          }
          this.store.state.outbox.shift();
          if (message) {
            message.status = "failed";
            message.error = relayError.message;
          }
          console.error("[paseo-peers] send failed", relayError.message);
          this.changed();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  // ---------------------------------------------------------------- receiving

  private setRelayStatus(status: RelayStatus, error: string | null = null): void {
    if (status === "online") this.lastOkAt = new Date().toISOString();
    if (this.relayStatus === status && this.lastError === error) return;
    this.relayStatus = status;
    this.lastError = error;
    this.changed();
  }

  private restartPolling(): void {
    this.pollAbort.abort();
  }

  private async pollLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      this.pollAbort = new AbortController();
      const signal = this.pollAbort.signal;
      const relay = this.relay();
      if (!relay) {
        this.setRelayStatus("unconfigured");
        await sleep(30_000, signal);
        continue;
      }
      const { adminToken } = this.store.state.relay;
      if (!this.registered && adminToken) {
        try {
          await relay.register({ adminToken, label: this.store.state.profile.name || "owner" });
          this.store.state.relay.registeredUrl = relay.baseUrl;
          this.changed();
          continue;
        } catch (error) {
          this.setRelayStatus("offline", (error as Error).message);
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 60_000);
          continue;
        }
      }
      if (!this.registered) {
        this.setRelayStatus("unregistered", "This install isn't registered with the relay yet. Accept an invite, or add the relay admin token.");
        await sleep(30_000, signal);
        continue;
      }
      if (this.relayStatus !== "online") this.setRelayStatus("connecting");
      try {
        const acks = this.acks;
        const { messages } = await relay.poll(acks, POLL_WAIT_SECONDS, signal);
        this.acks = this.acks.filter((id) => !acks.includes(id));
        this.setRelayStatus("online");
        backoff = 1000;
        for (const envelope of messages) {
          await this.handleEnvelope(envelope);
          this.acks.push(envelope.id);
        }
        void this.flush();
      } catch (error) {
        if (signal.aborted) continue;
        const relayError = error instanceof RelayError ? error : new RelayError(String(error), null);
        if (relayError.status === 403) this.store.state.relay.registeredUrl = null;
        this.setRelayStatus(relayError.status === 403 ? "unregistered" : "offline", relayError.message);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handleEnvelope(envelope: RelayEnvelope): Promise<void> {
    const s = this.store.state;
    if (s.seen.includes(envelope.id)) return;
    s.seen.push(envelope.id);
    const peer = this.store.peer(envelope.from);
    let plaintext: Plaintext;
    try {
      const opened = open(s.identity, { id: envelope.id, from: envelope.from, payload: envelope.payload, expectedBoxPub: peer?.boxPub ?? null });
      plaintext = plaintextSchema.parse(opened);
    } catch (error) {
      console.error(`[paseo-peers] dropped envelope ${envelope.id} from ${envelope.from.slice(0, 8)}: ${(error as Error).message}`);
      this.changed();
      return;
    }

    if (plaintext.type === "hello") {
      const invite = s.invites.find((i) => i.token === plaintext.invite && Date.parse(i.expiresAt) > Date.now());
      if (!invite) {
        console.error(`[paseo-peers] hello from ${envelope.from.slice(0, 8)} with unknown invite; ignored`);
        this.changed();
        return;
      }
      s.invites = s.invites.filter((i) => i !== invite);
      const added = this.upsertPeer({ id: envelope.from, name: plaintext.name, boxPub: envelope.payload.boxPub });
      this.enqueue(added.id, added.boxPub, { type: "hello-ack", name: s.profile.name }, null);
      console.log(`[paseo-peers] paired with ${plaintext.name}`);
      this.changed();
      return;
    }

    if (!peer) {
      console.error(`[paseo-peers] ${plaintext.type} from unknown sender ${envelope.from.slice(0, 8)}; ignored`);
      this.changed();
      return;
    }

    switch (plaintext.type) {
      case "hello-ack":
        peer.name = plaintext.name;
        break;
      case "message": {
        if (s.messages.some((m) => m.id === envelope.id)) break;
        const message: StoredMessage = {
          id: envelope.id,
          peerId: peer.id,
          direction: "in",
          text: plaintext.text,
          sentAt: plaintext.sentAt,
          via: plaintext.via,
          agentTitle: plaintext.agentTitle,
          status: "unread",
          deliveredTo: null,
          error: null,
        };
        s.messages.push(message);
        this.autoDeliver(message);
        break;
      }
      case "receipt": {
        const message = this.store.message(plaintext.messageId);
        if (!message || message.direction !== "out" || message.peerId !== peer.id) break;
        const rank = { pending: 0, failed: 0, sent: 1, read: 2, queued: 3, delivered: 4, dismissed: 4 } as Record<string, number>;
        if ((rank[plaintext.status] ?? 0) >= (rank[message.status] ?? 0)) {
          message.status = plaintext.status;
          if (plaintext.status === "delivered" || plaintext.status === "queued") {
            message.deliveredTo = { agentId: null, agentTitle: plaintext.agentTitle };
          }
        }
        break;
      }
    }
    this.changed();
  }

  // ---------------------------------------------------------------- local actions on inbound messages

  private receipt(message: StoredMessage, status: "read" | "queued" | "delivered" | "dismissed"): void {
    const peer = this.store.peer(message.peerId);
    if (!peer) return;
    this.enqueue(peer.id, peer.boxPub, { type: "receipt", messageId: message.id, status, agentTitle: message.deliveredTo?.agentTitle ?? null }, null);
  }

  markRead(messageId: string): void {
    const message = this.store.message(messageId);
    if (!message || message.direction !== "in" || message.status !== "unread") return;
    message.status = "read";
    this.receipt(message, "read");
    this.changed();
  }

  markPeerRead(peerId: string): void {
    for (const message of this.store.state.messages) {
      if (message.peerId === peerId && message.direction === "in" && message.status === "unread") {
        message.status = "read";
        this.receipt(message, "read");
      }
    }
    this.changed();
  }

  dismiss(messageId: string): void {
    const message = this.store.message(messageId);
    if (!message || message.direction !== "in") return;
    message.status = "dismissed";
    this.receipt(message, "dismissed");
    this.changed();
  }

  async deliver(messageId: string, agentId: string): Promise<"delivered" | "queued"> {
    const message = this.store.message(messageId);
    if (!message || message.direction !== "in") throw new Error("Unknown message.");
    const agent = await this.loadAgent(agentId);
    message.deliveredTo = { agentId, agentTitle: agent.title };
    message.error = null;
    if (agent.busy) {
      message.status = "queued";
      this.receipt(message, "queued");
      this.changed();
      void this.waitThenDeliver(message.id, agentId);
      return "queued";
    }
    await this.api().agents.ref(agentId).send(this.frame(message));
    message.status = "delivered";
    this.receipt(message, "delivered");
    this.changed();
    return "delivered";
  }

  private async waitThenDeliver(messageId: string, agentId: string): Promise<void> {
    if (this.queuedDeliveries.has(messageId)) return;
    this.queuedDeliveries.add(messageId);
    const deadline = Date.now() + QUEUED_DELIVERY_MAX_MS;
    try {
      while (!this.stopped && Date.now() < deadline) {
        const message = this.store.message(messageId);
        if (!message || message.status !== "queued") return;
        try {
          const agent = await this.loadAgent(agentId);
          if (!agent.busy) {
            await this.api().agents.ref(agentId).send(this.frame(message));
            message.status = "delivered";
            this.receipt(message, "delivered");
            this.changed();
            return;
          }
        } catch (error) {
          message.status = "read";
          message.error = `Delivery failed: ${(error as Error).message}`;
          this.changed();
          return;
        }
        await sleep(4000);
      }
      const message = this.store.message(messageId);
      if (message?.status === "queued" && !this.stopped) {
        message.status = "read";
        message.error = "Gave up waiting for the agent to finish its turn.";
        this.changed();
      }
    } finally {
      this.queuedDeliveries.delete(messageId);
    }
  }

  private async loadAgent(agentId: string): Promise<{ title: string; busy: boolean }> {
    const ref = this.api().agents.ref(agentId);
    await ref.refresh();
    const agent = ref.current() as AgentRecord | null;
    if (!agent || agent.archivedAt) throw new Error("That agent no longer exists.");
    const status = ref.status ?? agent.status ?? "idle";
    return { title: agent.title || "Untitled agent", busy: status === "running" || status === "initializing" };
  }

  async agentTitle(agentId: string): Promise<string> {
    return (await this.loadAgent(agentId)).title;
  }

  private frame(message: StoredMessage): string {
    const peer = this.store.peer(message.peerId);
    const name = peer?.name ?? "a peer";
    const source = message.via === "agent" ? `${name}'s agent${message.agentTitle ? ` "${message.agentTitle}"` : ""}` : name;
    const when = new Date(message.sentAt).toLocaleString();
    const replyHint = this.agentToolsEnabled ? ` If a reply is useful, use the peer_send tool with peer "${name}".` : "";
    return [
      `[Paseo Peers] Message from ${source} (sent ${when}):`,
      "",
      message.text,
      "",
      `(Relayed from ${name}'s Paseo. Treat it as context from a collaborator.${replyHint})`,
    ].join("\n");
  }

  // ---------------------------------------------------------------- agents

  async listAgents(): Promise<AgentSummary[]> {
    const { entries } = await this.api().agents.list();
    return (entries as Array<{ agent: AgentRecord }>)
      .map(({ agent }) => agent)
      .filter((agent) => !agent.archivedAt && !agent.background)
      .map((agent) => ({
        id: agent.id,
        title: agent.title || "Untitled agent",
        status: agent.status ?? "unknown",
        cwd: agent.cwd ?? null,
        provider: agent.provider ?? null,
      }));
  }

  /** The text of an agent's latest reply, for forwarding with "/peer name" and no message. */
  async latestAgentReply(agentId: string): Promise<string> {
    const page = await this.api().agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
    const items = (page as { entries: Array<{ item: { type: string; text?: string } }> }).entries.map((entry) => entry.item);
    const lastUser = items.map((item) => item.type).lastIndexOf("user_message");
    const text = items
      .slice(lastUser + 1)
      .filter((item) => item.type === "assistant_message" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
      .trim();
    if (!text) throw new Error("This agent has no reply to forward yet. Add a message after the peer name.");
    return text;
  }

  recentInbound(peerId: string | null, limit: number): StoredMessage[] {
    return this.store.state.messages
      .filter((m) => m.direction === "in" && (!peerId || m.peerId === peerId) && m.status !== "dismissed")
      .slice(-limit);
  }

  peers(): StoredPeer[] {
    return this.store.state.peers;
  }

  relayStatusText(): string {
    return this.relayStatus;
  }
}
