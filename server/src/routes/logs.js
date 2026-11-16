import { Router } from "express";
import { getRecentLogs, readLogFile } from "../logger.js";

const router = Router();

// GET /api/logs?source=file|memory&limit=200&requestId=...&event=...&level=...
router.get("/logs", (req, res) => {
  const { source, limit, requestId, event, level } = req.query;
  const opts = { limit, requestId, event, level };
  const logs = source === "memory" ? getRecentLogs(opts) : readLogFile(opts);
  res.status(200).json({ count: logs.length, logs });
});

// GET /api/logs/view - self-contained HTML dashboard, polls the JSON API above.
router.get("/logs/view", (req, res) => {
  res.status(200).type("html").send(LOGS_VIEWER_HTML);
});

const LOGS_VIEWER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>PM Assistant POC - Logs</title>
<style>
  body { font-family: ui-monospace, Consolas, monospace; margin: 0; padding: 1rem; background: #0e0e10; color: #e6e6e6; }
  h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
  .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; align-items: center; }
  input, select { background: #1c1c1f; color: #e6e6e6; border: 1px solid #3a3a3f; border-radius: 4px; padding: 0.35rem 0.5rem; font-size: 0.85rem; }
  button { background: #2b6cb0; color: white; border: none; border-radius: 4px; padding: 0.35rem 0.75rem; font-size: 0.85rem; cursor: pointer; }
  button:hover { background: #2c5282; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #26262a; vertical-align: top; }
  th { color: #9a9aa0; position: sticky; top: 0; background: #0e0e10; }
  tr:hover { background: #17171a; }
  .lvl-error { color: #ff6b6b; }
  .lvl-warn { color: #f6c343; }
  .lvl-info { color: #79c0ff; }
  .data { color: #9a9aa0; white-space: pre-wrap; word-break: break-word; }
  .meta { color: #7d7d84; font-size: 0.75rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
  <h1>PM Assistant POC &mdash; Process Logs</h1>
  <div class="controls">
    <input id="requestId" placeholder="filter by requestId" size="24" />
    <input id="event" placeholder="filter by event" size="18" />
    <select id="level">
      <option value="">all levels</option>
      <option value="info">info</option>
      <option value="warn">warn</option>
      <option value="error">error</option>
    </select>
    <input id="limit" type="number" value="200" size="6" style="width:5rem" />
    <button id="refresh">Refresh</button>
    <label style="font-size:0.85rem"><input id="auto" type="checkbox" checked /> auto-refresh 3s</label>
  </div>
  <div class="meta" id="meta"></div>
  <table>
    <thead><tr><th>Time</th><th>Level</th><th>Event</th><th>Data</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
<script>
async function load() {
  const requestId = document.getElementById('requestId').value.trim();
  const event = document.getElementById('event').value.trim();
  const level = document.getElementById('level').value;
  const limit = document.getElementById('limit').value || 200;
  const params = new URLSearchParams({ limit });
  if (requestId) params.set('requestId', requestId);
  if (event) params.set('event', event);
  if (level) params.set('level', level);
  const res = await fetch('/api/logs?' + params.toString());
  const { count, logs } = await res.json();
  document.getElementById('meta').textContent = count + ' entries shown (most recent last)';
  const rows = logs.map(l => {
    const rest = Object.assign({}, l);
    delete rest.ts; delete rest.level; delete rest.event;
    return '<tr><td>' + (l.ts || '') + '</td><td class="lvl-' + l.level + '">' + l.level + '</td><td>' + l.event + '</td><td class="data">' + escapeHtml(JSON.stringify(rest)) + '</td></tr>';
  }).join('');
  document.getElementById('rows').innerHTML = rows;
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
document.getElementById('refresh').addEventListener('click', load);
let timer = setInterval(load, 3000);
document.getElementById('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 3000);
});
load();
</script>
</body>
</html>`;

export default router;
