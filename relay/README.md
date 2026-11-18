# Paseo Peers relay

A store-and-forward mailbox for the Paseo Peers plugin. It only ever handles ciphertext. Clients
prove they own an Ed25519 key on every request, the relay queues opaque payloads per recipient,
and recipients collect them by long-polling. It has no runtime dependencies (Node 22+).

## Run with Docker Compose

```bash
echo "RELAY_ADMIN_TOKEN=$(openssl rand -hex 32)" > .env   # see .env.example for optional tuning
docker compose up -d --build
curl -s http://localhost:6767/v1/health   # {"ok":true,"service":"paseo-peers-relay",...}
```

Registered keys, pending invites and undelivered messages are stored in `./data`. The compose file
runs the container as uid 1000; change `user:` if your host user differs. The image is built
locally, so the compose file opts it out of Watchtower.

Or run it directly: `RELAY_ADMIN_TOKEN=... node server.mjs`.

## Put it behind HTTPS

Expose it through any reverse proxy with TLS: Nginx Proxy Manager, Caddy, Traefik, nginx, or a
Cloudflare Tunnel. Proxy plain HTTP to port 6767. WebSocket support is not needed. Clients
long-poll for 25 seconds, well under nginx's default 60 s `proxy_read_timeout` and Cloudflare's
100 s limit, so the proxy needs no special config.

If Cloudflare proxies the hostname, set its SSL mode to **Full (strict)** rather than Flexible.
Otherwise a proxy that forces HTTPS redirects in a loop, and the admin token crosses the internet
in plain text between Cloudflare and your server.

The plugin refuses `http://` relay URLs except on localhost.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_ADMIN_TOKEN` | required (16+ chars) | Lets the owner's install register itself and create invites |
| `PORT` / `HOST` | `6767` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` (`/data` in Docker) | State and message queue |
| `MESSAGE_TTL_DAYS` | `14` | Undelivered messages expire after this |
| `MAX_BODY_BYTES` | `524288` | Largest request accepted |
| `MAX_QUEUE` | `2000` | Most messages waiting for one recipient |
| `SEND_RATE_PER_MIN` | `120` | Per-key send rate limit |

## API (v1)

Every `POST` except `/v1/invites` carries `x-peer-key`, `x-peer-ts` and `x-peer-sig` headers: an
Ed25519 signature over
`paseo-peers-relay/v1\n<METHOD>\n<path>\n<ts>\n<sha256(body) hex>`. Timestamps must be within
5 minutes, and each signature is accepted once.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /v1/health` | none | Liveness |
| `POST /v1/invites` | `Authorization: Bearer <admin>` | Create a single-use registration invite |
| `POST /v1/register` | signed + invite, or admin | Allow a key to use the relay |
| `POST /v1/send` | signed, registered | Queue `{to, id, payload}` for a registered recipient |
| `POST /v1/poll` | signed, registered | Acknowledge delivered ids, then return queued envelopes (waits up to 30 s) |

## Test

`npm test` runs `test/e2e.ts`: a real relay plus two plugin instances that pair, exchange
messages and receipts, and check that a reused invite is rejected. It uses the plugin's dev
dependencies, so run `npm install` in `../plugin` first.
