// security.ts
import dns from "dns/promises";

const BLOCKED_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
];

export function isPrivateIP(ip: string) {
  return BLOCKED_IP_RANGES.some((r) => r.test(ip));
}

export async function validateURL(url: string) {
  try {
    const u = new URL(url);

    if (!["http:", "https:"].includes(u.protocol)) {
      throw new Error("Only http/https allowed");
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
