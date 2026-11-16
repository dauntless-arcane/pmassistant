import { Router } from "express";
import express from "express";
import { markDone, getRequest } from "../store.js";
import { logger } from "../logger.js";

const router = Router();

// Atlassian Automation substitutes agent responses directly into the JSON body template,
// which produces invalid JSON when the response contains newlines or double quotes.
// Strategy: sanitize control chars first (fast path), then fall back to regex extraction.

function sanitizeControlChars(raw) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === "\\" && inString) { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch.charCodeAt(0) < 0x20) {
      const map = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
      out += map[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseCallbackBody(raw) {
  // Fast path: control-char sanitization is enough
  try {
    return JSON.parse(sanitizeControlChars(raw));
  } catch {
    // Slow path: agent output has unescaped quotes — extract fields by regex.
    logger.warn("callback_parse_fallback", { bytes: raw.length });

    // Loose match — any string value, not just UUID format
    const reqMatch = raw.match(/"requestId"\s*:\s*"([^"]*)"/);
    if (!reqMatch || !reqMatch[1]) throw new Error("Could not find requestId in callback body");

    // result: everything between first `"result": "` and the last `"` before end-of-body
    let result = "(could not parse result)";
    const resultKeyIdx = raw.indexOf('"result"');
    if (resultKeyIdx !== -1) {
      const colonIdx = raw.indexOf(":", resultKeyIdx);
      const valueStart = raw.indexOf('"', colonIdx + 1) + 1;
      const valueEnd = raw.lastIndexOf('"');
      if (valueEnd > valueStart) result = raw.slice(valueStart, valueEnd);
    }
    return { requestId: reqMatch[1], result };
  }
}

// Automation rule's outgoing webhook action should POST here with:
// { "requestId": "...", "result": "..." }
router.post("/callback", express.text({ type: "application/json", limit: process.env.BODY_LIMIT || "1mb" }), (req, res) => {
  let body;
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  logger.info("callback_received", { bytes: raw.length });
  try {
    body = parseCallbackBody(raw);
  } catch (e) {
    logger.error("callback_parse_failed", { errorType: "parse_error", bytes: raw.length });
    return res.status(400).json({ error: `Could not parse callback body: ${e.message}` });
  }
  const { requestId, result } = body || {};

  if (!requestId) {
    logger.warn("callback_missing_request_id", { bytes: raw.length });
    return res.status(400).json({ error: "Body must include 'requestId'." });
  }

  const existing = getRequest(requestId);
  if (!existing) {
    logger.warn("callback_unknown_request_id", { requestId });
    return res.status(404).json({ error: `Unknown requestId: ${requestId}` });
  }

  if (existing.expired) {
    logger.warn("callback_for_expired_request", { requestId });
    return res.status(410).json({ error: "Request expired before the callback arrived." });
  }

  // Strip lone surrogates — they break JSON.stringify in Node 20+ when the status is polled
  const safeResult = (result ?? "(no result field provided by automation)")
    .replace(/[\uD800-\uDFFF]/g, "�");
  markDone(requestId, safeResult);
  logger.info("callback_processed", { requestId, resultLength: safeResult.length });
  return res.status(200).json({ ok: true });
});

export default router;
