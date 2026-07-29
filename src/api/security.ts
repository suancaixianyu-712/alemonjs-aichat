// security.ts
import dns from "dns/promises";
import { isIP } from "node:net";

export function isPrivateIP(ip: string) {
  const normalized = ip.toLowerCase().split("%")[0];
  if (isIP(normalized) === 6) {
    if (normalized.startsWith("::ffff:")) {
      return isPrivateIP(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }

  if (isIP(normalized) !== 4) return true;
  const [first, second] = normalized.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export async function validateURL(url: string) {
  try {
    const u = new URL(url);

    if (!["http:", "https:"].includes(u.protocol)) {
      throw new Error("Only http/https allowed");
    }
    if (
      u.hostname === "localhost" ||
      u.hostname.endsWith(".localhost") ||
      u.hostname.endsWith(".local")
    ) {
      throw new Error("Access to local network is forbidden");
    }

    const ips = await dns.lookup(u.hostname, { all: true });

    for (const { address } of ips) {
      if (isPrivateIP(address)) {
        throw new Error("Access to private network is forbidden");
      }
    }

    return true;
  } catch (e: any) {
    throw new Error(`Invalid URL: ${e.message}`);
  }
}
