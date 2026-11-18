# Paseo Peers

Send context straight to a trusted collaborator's [Paseo](https://paseo.sh), without giving them
access to your machine and without a human copy-pasting between chat and an agent.

A message lands in the other person's **Peers** inbox. They deliver it to one of their agents with
one click, or let messages from you go to a chosen agent automatically. Their agents can reply with
a tool call. Messages are end-to-end encrypted and pass through a small relay that you host.

```
 your Paseo ──(encrypted)──▶ relay you host ──(encrypted)──▶ their Paseo ──▶ inbox ──▶ their agent
```

This repository contains:

| Folder | What it is |
| --- | --- |
| [`plugin/`](plugin) | The Paseo plugin. Both people install it. |
| [`relay/`](relay) | A zero-dependency store-and-forward relay. One person hosts it. |

## Why not just pair the two Paseo daemons?

A Paseo host connection is all or nothing: whoever connects to your daemon can run anything on
your machine. Paseo Peers gives each person a narrow mailbox instead. A paired peer can only drop
a message into your inbox, and you decide what any agent sees.

## Install the plugin

Requires Paseo 0.16.1 or newer. No `npm install` is needed: Paseo provides the runtime libraries.

```bash
paseo plugin install github:banthaherder/paseo-peers:plugin
```

Or in the app: **Settings → Plugins**, enable plugins, then install from the same source. Update
later with `paseo plugin update paseo-peers`.

## Set up

1. **Host the relay** (one person). See [`relay/README.md`](relay/README.md). Put it behind HTTPS
   and keep the `RELAY_ADMIN_TOKEN` it is started with.
2. **Relay owner:** open **Peers** in the Paseo sidebar and enter a display name, the relay URL
   and the admin token. The install registers itself with the relay.
3. **Invite:** Peers → **Invite** creates a one-time code (`paseo-peer:…`, valid 7 days). Send it
   to the other person over any channel.
4. **Join:** they install the plugin, open Peers → **Join with invite code**, and paste it. Both
   sides are paired.

## Use it

- **Inbox and threads:** an unread badge on Peers, a chat thread per peer, and receipts showing
  whether a message was seen, queued for an agent, or delivered to which agent.
- **Deliver to agent:** sends a message to an agent you pick as a framed prompt. If that agent is
  mid-turn, delivery waits for the turn to end.
- **Auto-deliver:** per peer, send their messages straight to one chosen agent.
- **`/peer <name> [message]`** in any agent composer. With no message, it forwards that agent's
  latest reply.
- **Agent tools:** `peer_send`, `peer_inbox` and `peer_list` let agents send context to a peer and
  read what peers sent. Paseo asks before an agent first uses them. Turn them off in the plugin's
  settings.

## Security model

- Each install generates an Ed25519 identity key and an X25519 encryption key, stored in
  `~/.paseo/plugin-data/paseo-peers/state.json` (mode 0600).
- Messages are encrypted with AES-256-GCM, using a key derived from both peers' X25519 keys
  (HKDF-SHA256), and signed by the sender with Ed25519. The relay cannot read, alter, replay or
  forge them. A message from an unknown key is dropped.
- The relay authenticates every request with an Ed25519 signature, rejects replays, and only
  accepts keys registered with the admin token or a single-use invite. It sees who talks to whom,
  when and how much, but never content.
- Pairing a peer gives them no access to your daemon. A delivered message does become a prompt to
  your agent, and agents act on prompts. That's why every message waits for your approval by
  default, and the agent's own permission mode still applies. Only enable auto-delivery for people
  you trust.

Known limits: one relay per install; no forward secrecy (static keys); message history is stored
locally in plain JSON.

## Develop

```bash
cd plugin && npm install && npm run typecheck
paseo plugin install "$PWD"            # install from your working copy
paseo plugin reload paseo-peers        # after edits
cd ../relay && npm test                # end-to-end test: real relay + two plugin instances
```
