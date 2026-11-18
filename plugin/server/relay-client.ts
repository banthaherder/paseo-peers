import { relayAuthHeaders, type Identity, type SealedPayload } from "./crypto";

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
  /** Worth retrying later: network failure, timeout, rate limit, or server error. */
  get transient(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

export interface RelayEnvelope {
  id: string;
  from: string;
  to: string;
  receivedAt: string;
  payload: SealedPayload;
}

/** An abort signal that fires after `ms`, or when `parent` aborts. */
function deadline(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export function normalizeRelayUrl(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Use https:// for a relay that isn't on localhost.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export class RelayClient {
  constructor(
    readonly baseUrl: string,
    private readonly identity: Identity,
  ) {}

  private async request<T>(path: string, body: unknown, options: { timeoutMs?: number; adminToken?: string | null; signed?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const text = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.signed !== false) Object.assign(headers, relayAuthHeaders(this.identity, "POST", path, text));
    if (options.adminToken) headers.authorization = `Bearer ${options.adminToken}`;
    const timeout = deadline(options.timeoutMs ?? 15_000, options.signal);
    let response: Response;
    let parsed: unknown = null;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers, body: text, signal: timeout.signal });
      parsed = await response.json().catch(() => null);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new RelayError(`Relay unreachable: ${(error as Error).message}`, null);
    } finally {
      timeout.clear();
    }
    if (!response.ok) {
      const message = (parsed as { error?: string } | null)?.error ?? response.statusText;
      throw new RelayError(`Relay ${response.status}: ${message}`, response.status);
    }
    return parsed as T;
  }

  async health(): Promise<void> {
    const timeout = deadline(8000);
    let response: Response;
    let body: { service?: string } | null;
    try {
      response = await fetch(`${this.baseUrl}/v1/health`, { signal: timeout.signal });
      body = (await response.json().catch(() => null)) as { service?: string } | null;
    } catch (error) {
      throw new RelayError(`Relay unreachable: ${(error as Error).message}`, null);
    } finally {
      timeout.clear();
    }
    if (!response.ok || body?.service !== "paseo-peers-relay") {
      throw new RelayError(`${this.baseUrl} doesn't look like a Paseo Peers relay (HTTP ${response.status}).`, response.status);
    }
  }

  register(input: { invite?: string; adminToken?: string | null; label: string }) {
    return this.request<{ registered: boolean; already: boolean }>(
      "/v1/register",
      { invite: input.invite, label: input.label },
      { adminToken: input.adminToken },
    );
  }

  createInvite(adminToken: string, label: string) {
    return this.request<{ invite: string; expiresAt: string }>("/v1/invites", { label }, { adminToken, signed: false });
  }

  send(to: string, id: string, payload: SealedPayload) {
    return this.request<{ queued: boolean }>("/v1/send", { to, id, payload });
  }

  poll(ack: string[], waitSeconds: number, signal: AbortSignal) {
    return this.request<{ messages: RelayEnvelope[] }>("/v1/poll", { ack, wait: waitSeconds }, { timeoutMs: (waitSeconds + 20) * 1000, signal });
  }
}
