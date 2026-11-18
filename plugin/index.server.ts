import type { PluginHandlerContext } from "@getpaseo/plugin/server";
type PaseoApi = PluginHandlerContext["paseo"];
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  acceptInvite,
  cancelInvite,
  configure,
  createInvite,
  deliverMessage,
  getState,
  listAgents,
  markPeerRead,
  removePeer,
  sendMessage,
  sendToPeerByName,
  setAgentTools,
  updateMessage,
  updatePeer,
  watchState,
} from "./shared/contracts";
import { PeerService } from "./server/service";
import { Store } from "./server/store";
import { createAgentTools } from "./server/tools";

export default function contribute(server: PluginServerContext) {
  let stopped = false;
  const ready: Promise<PeerService> = Store.open().then((store) => {
    const service = new PeerService(store);
    if (!stopped) service.start();
    return service;
  });
  ready.catch((error) => console.error("[paseo-peers] failed to start", error));

  /** Every handler and hook context carries a Paseo API; hand the first one to the service. */
  async function svc(paseo: PaseoApi): Promise<PeerService> {
    const service = await ready;
    service.attach(paseo);
    return service;
  }
  const ok = { ok: true as const };

  server.handle(getState, async (_input, { paseo }) => (await svc(paseo)).publicState());

  server.handle(watchState, async (_input, { paseo, push, signal }) => {
    const service = await svc(paseo);
    await push({ state: service.publicState() });
    const unsubscribe = service.subscribe((state) => void push({ state }).catch(() => {}));
    signal.addEventListener("abort", unsubscribe, { once: true });
  });

  server.handle(configure, async (input, { paseo }) => (await svc(paseo)).configure(input));

  server.handle(createInvite, async ({ label }, { paseo }) => (await svc(paseo)).createInvite(label));

  server.handle(cancelInvite, async ({ inviteId }, { paseo }) => {
    (await svc(paseo)).cancelInvite(inviteId);
    return ok;
  });

  server.handle(acceptInvite, async ({ code, name }, { paseo }) => (await svc(paseo)).acceptInvite(code, name));

  server.handle(sendMessage, async ({ peerId, text }, { paseo }) => ({
    messageId: (await svc(paseo)).sendMessage(peerId, text).id,
  }));

  server.handle(sendToPeerByName, async ({ args, agentId }, { paseo }) => {
    const service = await svc(paseo);
    const { peer, text } = service.parsePeerArgs(args);
    if (text) return { messageId: service.sendMessage(peer.id, text).id, peerName: peer.name };
    if (!agentId) throw new Error("Add a message after the peer name.");
    // "/peer name" with no message forwards this agent's latest reply.
    const reply = await service.latestAgentReply(agentId);
    const title = await service.agentTitle(agentId);
    return { messageId: service.sendMessage(peer.id, reply, "agent", title).id, peerName: peer.name };
  });

  server.handle(deliverMessage, async ({ messageId, agentId }, { paseo }) => ({
    status: await (await svc(paseo)).deliver(messageId, agentId),
  }));

  server.handle(updateMessage, async ({ messageId, action }, { paseo }) => {
    const service = await svc(paseo);
    if (action === "read") service.markRead(messageId);
    else if (action === "dismiss") service.dismiss(messageId);
    else service.retry(messageId);
    return ok;
  });

  server.handle(markPeerRead, async ({ peerId }, { paseo }) => {
    (await svc(paseo)).markPeerRead(peerId);
    return ok;
  });

  server.handle(updatePeer, async (input, { paseo }) => {
    const service = await svc(paseo);
    const title = input.autoDeliverAgentId ? await service.agentTitle(input.autoDeliverAgentId) : null;
    service.updatePeer(input, title);
    return ok;
  });

  server.handle(removePeer, async ({ peerId }, { paseo }) => {
    (await svc(paseo)).removePeer(peerId);
    return ok;
  });

  server.handle(listAgents, async (_input, { paseo }) => ({ agents: await (await svc(paseo)).listAgents() }));

  server.handle(setAgentTools, async ({ mode }, { paseo }) => {
    (await svc(paseo)).setAgentTools(mode);
    return ok;
  });

  let tools: ReturnType<typeof createAgentTools> | null = null;
  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    // Never let this hook fail: a throw here would block the agent's session from opening.
    try {
      const service = await svc(paseo);
      if (!service.agentToolsEnabled || request.background) return;
      tools ??= createAgentTools(service);
      return { ...request, tools: [...request.tools, ...tools] };
    } catch (error) {
      console.error("[paseo-peers] skipped attaching agent tools", error);
      return;
    }
  });

  return async () => {
    stopped = true;
    (await ready.catch(() => null))?.stop();
  };
}
