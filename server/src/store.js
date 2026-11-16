// Simple in-memory store for POC purposes.
// Swap for Redis/SQLite if this needs to survive server restarts
// or run across multiple server instances.

const requests = new Map();

// Pending requests that never get a callback are expired after this long
// (default 30 minutes). Expired requests are reported as status "error" with
// expired: true so existing clients keep working unchanged.
export const PENDING_TTL_MS = (Number(process.env.PENDING_TTL_MINUTES) || 30) * 60 * 1000;

export function createRequest(requestId, { agentId, agentName, message }) {
  requests.set(requestId, {
    requestId,
    agentId,
    agentName,
    message,
    status: "pending", // "pending" | "done" | "error"
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export function markDone(requestId, result) {
  const entry = requests.get(requestId);
  if (!entry) return null;
  if (entry.expired) return entry; // late callback after expiry is ignored
  entry.status = "done";
  entry.result = result;
  entry.updatedAt = Date.now();
  return entry;
}

export function markError(requestId, error) {
  const entry = requests.get(requestId);
  if (!entry) return null;
  entry.status = "error";
  entry.error = String(error);
  entry.updatedAt = Date.now();
  return entry;
}

export function getRequest(requestId) {
  return requests.get(requestId) || null;
}

/**
 * Expires pending entries older than the TTL and drops finished entries that
 * have been around for longer than the TTL. Returns counts for logging.
 */
export function sweepExpired(now = Date.now()) {
  let expired = 0;
  let removed = 0;
  for (const [id, entry] of requests) {
    if (entry.status === "pending" && now - entry.createdAt > PENDING_TTL_MS) {
      entry.status = "error";
      entry.error = "Request expired: no response was received in time.";
      entry.expired = true;
      entry.updatedAt = now;
      expired++;
    } else if (entry.status !== "pending" && now - entry.updatedAt > PENDING_TTL_MS) {
      requests.delete(id);
      removed++;
    }
  }
  return { expired, removed };
}
