import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { MAX_MESSAGE_CHARS } from "../shared/contracts";
import type { PeerService } from "./service";

export function createAgentTools(service: PeerService) {
  const peerList = defineAgentTool({
    name: "peer_list",
    title: "List Paseo peers",
    description:
      "List the people whose Paseo this user is paired with through Paseo Peers. Use it to find the right name for peer_send.",
    input: z.object({}),
    execute() {
      const peers = service.peers();
      if (peers.length === 0) return { text: "No peers are paired yet." };
      return {
        text: peers.map((p) => `- ${p.name}`).join("\n"),
        structuredContent: { peers: peers.map((p) => ({ name: p.name, id: p.id })) },
      };
    },
  });

  const peerSend = defineAgentTool({
    name: "peer_send",
    title: "Send context to a peer",
    description:
      "Send a message to a paired collaborator's Paseo (another person's machine). Use it to hand over context their agents need: a changed API, a decision, a branch to pull, or a reply to a message they sent. The message lands in their Paseo Peers inbox, and they choose which agent receives it. Write it so it stands on its own.",
    input: z.object({
      peer: z.string().min(1).describe("Peer name as shown by peer_list"),
      message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe("Self-contained message text (Markdown is fine)"),
    }),
    execute({ peer, message }, { agent }) {
      const target = service.findPeerByName(peer);
      if (!target) {
        const names = service.peers().map((p) => p.name).join(", ") || "none";
        return { isError: true, text: `No peer named "${peer}". Paired peers: ${names}.` };
      }
      const sent = service.sendMessage(target.id, message, "agent", agent.title || null);
      return {
        text: `Queued for ${target.name} (message ${sent.id}). It will show in their inbox once delivered via the relay (status: ${service.relayStatusText()}).`,
        structuredContent: { messageId: sent.id, peer: target.name },
      };
    },
  });

  const peerInbox = defineAgentTool({
    name: "peer_inbox",
    title: "Read messages from peers",
    description:
      "Read recent messages that paired collaborators sent to this user's Paseo, including ones not yet delivered to any agent.",
    input: z.object({
      peer: z.string().optional().describe("Only messages from this peer"),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute({ peer, limit }) {
      const target = peer ? service.findPeerByName(peer) : null;
      if (peer && !target) return { isError: true, text: `No peer named "${peer}".` };
      const messages = service.recentInbound(target?.id ?? null, limit);
      if (messages.length === 0) return { text: "No messages from peers." };
      const names = new Map(service.peers().map((p) => [p.id, p.name]));
      return {
        text: messages
          .map((m) => {
            const from = `${names.get(m.peerId) ?? "unknown"}${m.via === "agent" ? ` (agent${m.agentTitle ? ` "${m.agentTitle}"` : ""})` : ""}`;
            return `### From ${from} at ${m.sentAt} [${m.status}]\n${m.text}`;
          })
          .join("\n\n"),
      };
    },
  });

  return [peerList, peerSend, peerInbox];
}
