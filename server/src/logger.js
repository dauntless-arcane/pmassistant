import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Structured, file-persisted logging so the whole ask -> route -> webhook ->
// callback -> status lifecycle can be inspected anytime, not just while
// watching a terminal. Every entry is one JSON line in logs/app.log,
// correlated by requestId where available.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

fs.mkdirSync(LOG_DIR, { recursive: true });

const RING_BUFFER_SIZE = 1000;
const ringBuffer = [];

function write(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };

  ringBuffer.push(entry);
  if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();

  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${entry.ts}] [${level.toUpperCase()}] ${event}`, data);

  fs.appendFile(LOG_FILE, JSON.stringify(entry) + "\n", (err) => {
    if (err) console.error("Failed to write log file:", err.message);
  });

  return entry;
}

export const logger = {
  info: (event, data) => write("info", event, data),
  warn: (event, data) => write("warn", event, data),
  error: (event, data) => write("error", event, data),
};

function filterEntries(entries, { requestId, event, level, limit = 200 } = {}) {
  let result = entries;
  if (requestId) result = result.filter((e) => e.requestId === requestId);
  if (event) result = result.filter((e) => e.event === event);
  if (level) result = result.filter((e) => e.level === level);
  return result.slice(-Number(limit) || -200);
}

// Fast path: last RING_BUFFER_SIZE entries held in memory since process start.
export function getRecentLogs(opts) {
  return filterEntries(ringBuffer, opts);
}

// Full path: re-reads the persisted file, so it survives restarts.
export function readLogFile(opts) {
  let raw;
  try {
    raw = fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, level: "unknown", event: "unparseable_log_line", raw: line };
      }
    });
  return filterEntries(entries, opts);
}

export const LOG_FILE_PATH = LOG_FILE;
