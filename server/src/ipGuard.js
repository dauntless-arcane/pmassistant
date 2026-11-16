import ipaddr from "ipaddr.js";
import { logger } from "./logger.js";

// Locks the public tunnel down to Atlassian: requests that arrive through a
// tunnel/proxy (X-Forwarded-For present) may only reach the callback endpoints,
// and only from Atlassian egress IPs. Direct localhost use is unaffected.
//
// Env:
//   CALLBACK_IP_GUARD      "off" to disable (default on)
//   CALLBACK_EXTRA_CIDRS   extra comma-separated CIDRs to allow
//   CALLBACK_SHARED_SECRET if set, callbacks must send it as X-Callback-Secret
//                          (add the header in the Automation webhook action)

const RANGES_URL = "https://ip-ranges.atlassian.com/";
const ALLOWED_PATHS = new Set(["/api/callback", "/api/route-callback", "/api/health"]);
let ranges = [];

function parseCidr(c) {
  try { return ipaddr.parseCIDR(c.trim()); } catch { return null; }
}

function inRanges(ipStr) {
  let ip;
  try { ip = ipaddr.process(ipStr); } catch { return false; }
  return ranges.some(([net, bits]) => net.kind() === ip.kind() && ip.match(net, bits));
}

export async function loadAtlassianRanges() {
  const cidrs = (process.env.CALLBACK_EXTRA_CIDRS || "").split(",").filter(Boolean);
  try {
    const res = await fetch(RANGES_URL, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    for (const i of data.items || []) if (i.cidr) cidrs.push(i.cidr);
  } catch (e) {
    logger.error("atlassian_ranges_fetch_failed", { errorType: e.name });
  }
  ranges = cidrs.map(parseCidr).filter(Boolean);
  logger.info("atlassian_ranges_loaded", { count: ranges.length });
}

export function ipGuard(req, res, next) {
  if (process.env.CALLBACK_IP_GUARD === "off") return next();
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return next(); // direct local access, not via the tunnel

  // The tunnel appends the real peer last; earlier entries are client-controlled.
  const clientIp = String(xff).split(",").pop().trim();
  if (!ALLOWED_PATHS.has(req.path) || !inRanges(clientIp)) {
    logger.warn("ip_guard_blocked", { path: req.path });
    return res.status(403).json({ error: "Forbidden" });
  }

  const secret = process.env.CALLBACK_SHARED_SECRET;
  if (secret && req.path !== "/api/health" && req.headers["x-callback-secret"] !== secret) {
    logger.warn("ip_guard_bad_secret", { path: req.path });
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}
