Paseo Peers lets you send context straight to a trusted friend's Paseo. A message lands in their Peers inbox, and they deliver it to one of their agents with one click, or let your messages go to a chosen agent automatically. It replaces the step where you message a person so they can paste it into their agent.

## How it works

Each install has its own keypair. Messages are encrypted end to end (X25519 and AES-256-GCM, signed with Ed25519) and pass through a small relay that you host. The relay only stores ciphertext until the recipient's Paseo picks it up, so a sleeping laptop catches up when it wakes. Paired peers never get any access to each other's daemon. They can only drop messages into the inbox.

## Setup

1. One person runs the relay (the `relay/` folder of the source repository: a zero-dependency Node service with a Docker Compose file) behind HTTPS, with a `RELAY_ADMIN_TOKEN`.
2. On your install, open Peers and enter your name, the relay URL and the admin token.
3. Choose Invite to create a one-time code and send it to your friend once. They install Paseo Peers, choose Join and paste the code. Both sides are then paired.

## What you get

- A Peers inbox in the sidebar with unread counts, a chat thread per peer, and receipts showing when a message was seen, queued or delivered to one of their agents.
- Deliver to agent: sends the message to an agent you pick. If that agent is mid-turn, delivery waits for the turn to end.
- Auto-deliver (per peer): sends that peer's messages straight to one agent without asking.
- `/peer <name> [message]` in any agent composer. With no message, it forwards that agent's latest reply.
- Agent tools `peer_send`, `peer_inbox` and `peer_list`, so your agents can send context to a peer and read what peers sent. You can turn these off in settings.

## Limits

One relay per install. Message history stays on each machine under `~/.paseo/plugin-data/paseo-peers`. The relay sees which keys talk to each other, when, and how much, but never the content. Delivered messages become prompts to the receiving agent, so only pair with people you trust. Their agent's own permission mode still applies.
