import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_MESSAGE_CHARS = 32_000;

export const relayStatusSchema = z.enum(["unconfigured", "connecting", "online", "offline", "unregistered"]);
export type RelayStatus = z.infer<typeof relayStatusSchema>;

export const inboundStatusSchema = z.enum(["unread", "read", "queued", "delivered", "dismissed"]);
export const outboundStatusSchema = z.enum(["pending", "sent", "read", "queued", "delivered", "dismissed", "failed"]);

export const messageSchema = z.object({
  id: z.string(),
  peerId: z.string(),
  direction: z.enum(["in", "out"]),
  text: z.string(),
  sentAt: z.string(),
  /** Who wrote it: the person, or one of their agents. */
  via: z.enum(["human", "agent"]),
  agentTitle: z.string().nullable(),
  status: z.union([inboundStatusSchema, outboundStatusSchema]),
  /** Inbound: the local agent it went to. Outbound: the peer's agent, from their receipt. */
  deliveredTo: z.object({ agentId: z.string().nullable(), agentTitle: z.string().nullable() }).nullable(),
  error: z.string().nullable(),
});
export type PeerMessage = z.infer<typeof messageSchema>;

export const peerSchema = z.object({
  id: z.string(),
  name: z.string(),
  fingerprint: z.string(),
  addedAt: z.string(),
  autoDeliverAgentId: z.string().nullable(),
  autoDeliverAgentTitle: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  unread: z.number(),
});
export type Peer = z.infer<typeof peerSchema>;

export const inviteSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const stateSchema = z.object({
  configured: z.boolean(),
  profile: z.object({ name: z.string() }),
  identity: z.object({ signPub: z.string(), fingerprint: z.string() }),
  relay: z.object({
    url: z.string().nullable(),
    hasAdminToken: z.boolean(),
    registered: z.boolean(),
    status: relayStatusSchema,
    lastError: z.string().nullable(),
    lastOkAt: z.string().nullable(),
  }),
  agentTools: z.enum(["all", "off"]),
  peers: z.array(peerSchema),
  messages: z.array(messageSchema),
  invites: z.array(inviteSchema),
  unreadTotal: z.number(),
});
export type PeersState = z.infer<typeof stateSchema>;

const ok = z.object({ ok: z.literal(true) });

export const getState = defineRpc({ name: "peers.state", input: z.object({}), output: stateSchema });

export const watchState = defineSubscription({
  name: "peers.watch",
  input: z.object({}),
  event: z.object({ state: stateSchema }),
});

export const configure = defineRpc({
  name: "peers.configure",
  input: z.object({
    name: z.string().trim().min(1).max(60).optional(),
    relayUrl: z.string().trim().max(300).optional(),
    /** Empty string clears it. */
    adminToken: z.string().trim().max(300).optional(),
  }),
  output: stateSchema,
});

export const createInvite = defineRpc({
  name: "peers.invite.create",
  input: z.object({ label: z.string().trim().max(60).optional() }),
  output: z.object({ code: z.string(), expiresAt: z.string() }),
});

export const cancelInvite = defineRpc({ name: "peers.invite.cancel", input: z.object({ inviteId: z.string() }), output: ok });

export const acceptInvite = defineRpc({
  name: "peers.invite.accept",
  input: z.object({ code: z.string().trim().min(10).max(4000), name: z.string().trim().min(1).max(60).optional() }),
  output: z.object({ peerId: z.string(), peerName: z.string() }),
});

export const sendMessage = defineRpc({
  name: "peers.send",
  input: z.object({ peerId: z.string(), text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) }),
  output: z.object({ messageId: z.string() }),
});

/** Sends to a peer by name; used by the /peer slash command. */
export const sendToPeerByName = defineRpc({
  name: "peers.send-by-name",
  input: z.object({
    args: z.string(),
    /** When the message part is empty, forward this agent's latest reply instead. */
    agentId: z.string().optional(),
  }),
  output: z.object({ messageId: z.string(), peerName: z.string() }),
});

export const deliverMessage = defineRpc({
  name: "peers.deliver",
  input: z.object({ messageId: z.string(), agentId: z.string() }),
  output: z.object({ status: z.enum(["delivered", "queued"]) }),
});

export const updateMessage = defineRpc({
  name: "peers.message.update",
  input: z.object({ messageId: z.string(), action: z.enum(["read", "dismiss", "retry"]) }),
  output: ok,
});

export const markPeerRead = defineRpc({ name: "peers.mark-read", input: z.object({ peerId: z.string() }), output: ok });

export const updatePeer = defineRpc({
  name: "peers.update",
  input: z.object({
    peerId: z.string(),
    name: z.string().trim().min(1).max(60).optional(),
    autoDeliverAgentId: z.string().nullable().optional(),
  }),
  output: ok,
});

export const removePeer = defineRpc({ name: "peers.remove", input: z.object({ peerId: z.string() }), output: ok });

export const agentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  /** Working directory with the home directory shortened to "~". */
  cwd: z.string().nullable(),
  provider: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  projectName: z.string().nullable(),
  branch: z.string().nullable(),
  /** Workspace label names (colors aren't available to plugins). */
  labels: z.array(z.string()),
  lastActivityAt: z.string().nullable(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const listAgents = defineRpc({
  name: "peers.agents",
  input: z.object({}),
  output: z.object({ agents: z.array(agentSummarySchema) }),
});

export const setAgentTools = defineRpc({
  name: "peers.agent-tools",
  input: z.object({ mode: z.enum(["all", "off"]) }),
  output: ok,
});
