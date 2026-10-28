// Fastify `trustProxy` from TRUST_PROXY, so req.ip (rate limits, audit logs,
// login throttling) comes from the proxy we actually run, not from whatever
// X-Forwarded-For a client sends.
//
//   unset        → 1: trust exactly one hop (Kong in front of every service)
//   a number     → that many hops (2 = load balancer + Kong); 0 = trust none
//   a CIDR list  → comma separated addresses/CIDRs of the proxies, e.g.
//                  "10.0.0.0/8,172.16.0.0/12" (proxy-addr also accepts
//                  loopback, linklocal, uniquelocal)
//
// `true` (trust every hop, i.e. the left-most client-supplied address) is
// rejected on purpose.

const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

/** proxy-addr's own rule for a hop count: trust the first `n` hops from the socket. */
export type TrustProxyFn = ((address: string, hop: number) => boolean) & { hops?: number };

function hops(n: number): TrustProxyFn {
  const fn: TrustProxyFn = (_address, hop) => hop < n;
  fn.hops = n;
  return fn;
}

/** Fastify's `trustProxy` option (a hop-count function or a list of proxy addresses). */
export function trustProxyFromEnv(raw: string | undefined = process.env.TRUST_PROXY): TrustProxyFn | string[] {
  const value = raw?.trim();
  if (!value) return hops(1);
  if (/^\d+$/.test(value)) return hops(Number(value));
  if (["true", "yes", "on", "*"].includes(value.toLowerCase())) {
    throw new Error("TRUST_PROXY=true would trust a client-supplied X-Forwarded-For; set a hop count (default 1) or the proxies' CIDRs");
  }
  if (["false", "no", "off"].includes(value.toLowerCase())) return hops(0);
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    if (!KEYWORDS.has(entry) && !IPV4.test(entry) && !(entry.includes(":") && IPV6.test(entry))) {
      throw new Error(`TRUST_PROXY: "${entry}" is not a hop count, an IP/CIDR or loopback/linklocal/uniquelocal`);
    }
  }
  return list;
}
