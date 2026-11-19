import * as tls from "node:tls";

type TlsCaApi = {
  getCACertificates?: (type: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

/**
 * Paseo's plugin runtime trusts only Node's bundled CA list. Add the OS trust store so relays
 * behind VPNs or security tools that inspect HTTPS (their root lives in the macOS keychain or
 * the system store) still connect. Returns how many system certificates were added.
 */
export function trustSystemCertificates(): number {
  const api = tls as unknown as TlsCaApi;
  if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") return 0;
  try {
    const system = api.getCACertificates("system");
    if (system.length === 0) return 0;
    const current = api.getCACertificates("default");
    const merged = [...new Set([...current, ...system])];
    if (merged.length === current.length) return 0;
    api.setDefaultCACertificates(merged);
    return merged.length - current.length;
  } catch (error) {
    console.error("[paseo-peers] couldn't load system certificates", error);
    return 0;
  }
}
