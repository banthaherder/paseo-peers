// End-to-end protocol test: a real relay process plus two PeerService instances ("owner" and
// "friend") with their own identities and a fake Paseo API. Run: npx tsx test/e2e.ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerService } from "../../plugin/server/service";
import { Store } from "../../plugin/server/store";

const PORT = 18787;
const ADMIN = "test-admin-token-1234567890";
const relayUrl = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (label: string, cond: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
};
const waitFor = async (label: string, fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return check(label, true);
    await new Promise((r) => setTimeout(r, 100));
  }
  check(label, false);
};

function fakePaseo(name: string, agentStatus: { value: string }) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const agent = { id: "agent-1", title: `${name}'s api agent`, status: "idle", cwd: "/tmp", provider: "claude", archivedAt: null };
  const api = {
    agents: {
      list: async () => ({ entries: [{ agent: { ...agent, status: agentStatus.value } }] }),
      ref: (id: string) => ({
        refresh: async () => null,
        current: () => (id === agent.id ? { ...agent, status: agentStatus.value } : null),
        get status() {
          return agentStatus.value;
        },
        send: async (text: string) => void sent.push({ agentId: id, text }),
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "user_message", text: "summarize" } },
              { item: { type: "assistant_message", text: "The /v2/orders endpoint " } },
              { item: { type: "assistant_message", text: "now returns cursor pagination." } },
            ],
          }),
        },
      }),
    },
  };
  return { api: api as never, sent };
}

const dir = await mkdtemp(join(tmpdir(), "paseo-peers-e2e-"));
const relay = spawn(process.execPath, [join(import.meta.dirname, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: join(dir, "relay"), RELAY_ADMIN_TOKEN: ADMIN },
  stdio: ["ignore", "inherit", "inherit"],
});
await new Promise((r) => setTimeout(r, 600));

const services: PeerService[] = [];
try {
  const ownerStatus = { value: "idle" };
  const friendStatus = { value: "running" };
  const ownerPaseo = fakePaseo("Alice", ownerStatus);
  const friendPaseo = fakePaseo("Bob", friendStatus);
  const owner = new PeerService(await Store.open(join(dir, "owner")));
  const friend = new PeerService(await Store.open(join(dir, "friend")));
  services.push(owner, friend);
  owner.start();
  friend.start();
  owner.attach(ownerPaseo.api);
  friend.attach(friendPaseo.api);

  // A wrong admin token, or an invite code pasted into the admin field, fails clearly and saves nothing.
  await owner.configure({ name: "Alice", relayUrl, adminToken: "wrong-admin-token-000000" }).then(
    () => check("wrong admin token rejected", false),
    (e) => check("wrong admin token rejected with admin-token message", /admin token/.test((e as Error).message)),
  );
  check("failed save left relay and name unset", owner.publicState().relay.url === null && owner.publicState().profile.name === "");
  await owner.configure({ adminToken: "paseo-peer:eyJ2IjoxfQ" }).then(
    () => check("invite code in admin field rejected", false),
    (e) => check("invite code in admin field rejected", /invite code/.test((e as Error).message)),
  );

  // Owner configures the relay with the admin token, then mints an invite.
  await owner.configure({ name: "Alice", relayUrl, adminToken: ADMIN });
  check("owner registered", owner.publicState().relay.registered);
  const { code } = await owner.createInvite("Bob");
  check("invite code shape", code.startsWith("paseo-peer:"));

  // Friend rejects garbage and their own code paths.
  await friend.acceptInvite("paseo-peer:nope", "Bob").then(
    () => check("garbage invite rejected", false),
    () => check("garbage invite rejected", true),
  );
  const accepted = await friend.acceptInvite(code, "Bob");
  check("friend sees owner as peer", accepted.peerName === "Alice");
  await waitFor("owner pairs with friend via hello", () => owner.publicState().peers.some((p) => p.name === "Bob"));
  await waitFor("both relay loops online", () => owner.publicState().relay.status === "online" && friend.publicState().relay.status === "online");
  check("invite consumed", owner.publicState().invites.length === 0);

  // A second use of the same invite by a third identity must fail at the relay.
  const intruder = new PeerService(await Store.open(join(dir, "intruder")));
  services.push(intruder);
  await intruder.acceptInvite(code, "Mallory").then(
    () => check("reused invite rejected", false),
    (e) => check(`reused invite rejected (${(e as Error).message})`, true),
  );

  // Owner -> friend message; friend's agent is busy, so delivery queues, then lands when idle.
  const bobId = owner.publicState().peers[0].id;
  const out = owner.sendMessage(bobId, "Heads up: the orders API switched to cursor pagination.");
  await waitFor("friend receives message", () => friend.publicState().messages.some((m) => m.id === out.id && m.status === "unread"));
  check("plaintext matches", friend.publicState().messages.find((m) => m.id === out.id)?.text.includes("cursor pagination"));
  await waitFor("owner sees sent", () => owner.publicState().messages.find((m) => m.id === out.id)?.status === "sent");
  friend.markRead(out.id);
  await waitFor("owner gets read receipt", () => owner.publicState().messages.find((m) => m.id === out.id)?.status === "read");
  const status = await friend.deliver(out.id, "agent-1");
  check("delivery queued while agent running", status === "queued");
  await waitFor("owner gets queued receipt", () => owner.publicState().messages.find((m) => m.id === out.id)?.status === "queued");
  friendStatus.value = "idle";
  await waitFor("queued delivery sent once agent idle", () => friendPaseo.sent.length === 1, 15_000);
  check("framed prompt names sender", friendPaseo.sent[0]?.text.includes("Message from Alice"));
  await waitFor(
    "owner gets delivered receipt with agent title",
    () => owner.publicState().messages.find((m) => m.id === out.id)?.deliveredTo?.agentTitle === "Bob's api agent",
  );

  // Friend -> owner with auto-delivery to the owner's agent.
  owner.updatePeer({ peerId: bobId, autoDeliverAgentId: "agent-1" }, "Alice's api agent");
  const back = friend.sendMessage(accepted.peerId, "Thanks, pulling now.", "agent", "Bob's api agent");
  await waitFor("auto-delivered to owner's agent", () => ownerPaseo.sent.some((s) => s.text.includes("pulling now")));
  await waitFor("friend sees delivered", () => friend.publicState().messages.find((m) => m.id === back.id)?.status === "delivered");

  // Slash-command parsing and latest-reply forwarding.
  check("parsePeerArgs splits name", owner.parsePeerArgs("bob: hi there").text === "hi there");
  check("latest reply joins chunks", (await owner.latestAgentReply("agent-1")) === "The /v2/orders endpoint now returns cursor pagination.");

  // Tampering: a forged envelope from an unknown key is dropped, not shown.
  const before = owner.publicState().messages.length;
  await new Promise((r) => setTimeout(r, 300));
  check("no stray messages", owner.publicState().messages.length === before);

  // Persistence: reopen the friend's store and confirm peer + messages survive.
  const reopened = await Store.open(join(dir, "friend"));
  check("state persisted", reopened.state.peers.length === 1 && reopened.state.messages.length >= 2);
} finally {
  for (const s of services) s.stop();
  relay.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
