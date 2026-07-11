import { Router } from 'express';
import { listRecentRecords, getRecord, computeCompleteness } from '../lib/supabase.js';

const router = Router();

// GET /api/records — JSON list of recent intake records for the dashboard.
router.get('/api/records', async (req, res) => {
  try {
    const records = await listRecentRecords(20);
    const withCompleteness = records.map((r) => ({
      ...r,
      completeness: computeCompleteness(r.fields),
    }));
    res.json({ records: withCompleteness });
  } catch (err) {
    console.error('[dashboard] GET /api/records failed:', err);
    res.status(500).json({ error: err.message || 'Failed to load records' });
  }
});

// GET /api/records/:callSid — JSON single record.
router.get('/api/records/:callSid', async (req, res) => {
  try {
    const record = await getRecord(req.params.callSid);
    if (!record) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }
    res.json({ record: { ...record, completeness: computeCompleteness(record.fields) } });
  } catch (err) {
    console.error('[dashboard] GET /api/records/:callSid failed:', err);
    res.status(500).json({ error: err.message || 'Failed to load record' });
  }
});

// GET / — the dashboard page itself (inline HTML/CSS/JS, no build step).
router.get('/', (req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mock EHR — Live Intake Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0f14;
    --panel: #131a22;
    --panel-border: #232d38;
    --text: #e6edf3;
    --muted: #8b98a5;
    --accent: #4f9dff;
    --green-bg: #0f2e1c;
    --green-text: #4ade80;
    --green-border: #1f5c37;
    --yellow-bg: #332b0d;
    --yellow-text: #facc15;
    --yellow-border: #5c4d16;
    --gray-bg: #1c222a;
    --gray-text: #9aa4af;
    --gray-border: #2c3742;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --panel-border: #e2e8f0;
      --text: #16202a;
      --muted: #5b6b7a;
      --accent: #1d6fe0;
      --green-bg: #e7f8ee;
      --green-text: #15803d;
      --green-border: #b7e4c7;
      --yellow-bg: #fff8e1;
      --yellow-text: #92700a;
      --yellow-border: #f3e0a0;
      --gray-bg: #eef1f4;
      --gray-text: #5b6b7a;
      --gray-border: #dbe2e8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header {
    padding: 20px 28px;
    border-bottom: 1px solid var(--panel-border);
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  header .badge {
    font-size: 12px;
    color: var(--muted);
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    padding: 3px 10px;
  }
  main { padding: 20px 28px 60px; max-width: 1000px; margin: 0 auto; }
  .empty {
    color: var(--muted);
    padding: 40px 0;
    text-align: center;
  }
  .record {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  .record-summary {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr;
    gap: 12px;
    align-items: center;
    padding: 14px 18px;
    cursor: pointer;
    user-select: none;
  }
  .record-summary:hover { background: rgba(127,127,127,0.06); }
  .record-summary .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .record-summary .value { font-size: 14px; margin-top: 2px; word-break: break-word; }
  .status-pill {
    display: inline-block;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--panel-border);
    text-transform: capitalize;
  }
  .status-in_progress { color: var(--accent); border-color: var(--accent); }
  .status-completed { color: var(--green-text); border-color: var(--green-border); }
  .status-emergency_escalated { color: #ef4444; border-color: #ef4444; }
  .status-dropped, .status-voicemail { color: var(--muted); }
  .completeness-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--gray-bg);
    overflow: hidden;
    margin-top: 6px;
  }
  .completeness-fill { height: 100%; background: var(--accent); }
  .record-detail {
    display: none;
    border-top: 1px solid var(--panel-border);
    padding: 16px 18px 20px;
  }
  .record.expanded .record-detail { display: block; }
  .fields-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }
  .field-chip {
    border-radius: 8px;
    padding: 10px 12px;
    border: 1px solid;
  }
  .field-chip .key {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.85;
  }
  .field-chip .val {
    font-size: 14px;
    margin-top: 4px;
    font-weight: 500;
    word-break: break-word;
  }
  .field-chip .state {
    font-size: 10px;
    margin-top: 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.75;
  }
  .state-captured { background: var(--green-bg); color: var(--green-text); border-color: var(--green-border); }
  .state-patient_declined { background: var(--yellow-bg); color: var(--yellow-text); border-color: var(--yellow-border); }
  .state-unable_to_capture { background: var(--gray-bg); color: var(--gray-text); border-color: var(--gray-border); }
  .missing-note { color: var(--muted); font-size: 12px; margin-top: 12px; }
  .last-updated { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>Mock EHR — Live Intake Dashboard</h1>
  <span class="badge" id="live-badge">live · polling every 3s</span>
</header>
<main>
  <div id="records-container">
    <div class="empty">Loading records…</div>
  </div>
</main>
<script>
  const POLL_MS = 3000;
  let expandedSid = null;

  function fieldStateClass(state) {
    if (state === 'captured') return 'state-captured';
    if (state === 'patient_declined') return 'state-patient_declined';
    if (state === 'unable_to_capture') return 'state-unable_to_capture';
    return '';
  }

  function formatFieldKey(key) {
    return key.replace(/_/g, ' ').replace(/\\b\\w/g, (c) => c.toUpperCase());
  }

  function formatValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function renderFields(fields) {
    const keys = Object.keys(fields || {});
    if (keys.length === 0) {
      return '<div class="missing-note">No fields captured yet.</div>';
    }
    return '<div class="fields-grid">' + keys.map((key) => {
      const entry = fields[key] || {};
      return \`
        <div class="field-chip \${fieldStateClass(entry.state)}">
          <div class="key">\${formatFieldKey(key)}</div>
          <div class="val">\${formatValue(entry.value)}</div>
          <div class="state">\${(entry.state || 'unknown').replace(/_/g, ' ')}</div>
        </div>
      \`;
    }).join('') + '</div>';
  }

  function renderRecord(r) {
    const pct = r.completeness.totalRequired
      ? Math.round(((r.completeness.captured + r.completeness.declinedOrUnable) / r.completeness.totalRequired) * 100)
      : 0;
    const isExpanded = r.call_sid === expandedSid;
    return \`
      <div class="record \${isExpanded ? 'expanded' : ''}" data-sid="\${r.call_sid}">
        <div class="record-summary" onclick="toggleRecord('\${r.call_sid}')">
          <div>
            <div class="label">Call SID</div>
            <div class="value">\${r.call_sid}</div>
          </div>
          <div>
            <div class="label">Phone</div>
            <div class="value">\${formatValue(r.phone_number)}</div>
          </div>
          <div>
            <div class="label">Status</div>
            <div class="value"><span class="status-pill status-\${r.call_status}">\${(r.call_status || '').replace(/_/g, ' ')}</span></div>
          </div>
          <div>
            <div class="label">Completeness</div>
            <div class="value">\${pct}% (\${r.completeness.captured}/\${r.completeness.totalRequired})</div>
            <div class="completeness-bar"><div class="completeness-fill" style="width:\${pct}%"></div></div>
          </div>
          <div>
            <div class="label">Updated</div>
            <div class="value last-updated">\${new Date(r.updated_at).toLocaleTimeString()}</div>
          </div>
        </div>
        <div class="record-detail">
          \${renderFields(r.fields)}
          \${r.completeness.missing.length ? \`<div class="missing-note">Missing required: \${r.completeness.missing.join(', ')}</div>\` : ''}
        </div>
      </div>
    \`;
  }

  window.toggleRecord = function (sid) {
    expandedSid = expandedSid === sid ? null : sid;
    render(window.__lastRecords || []);
  };

  function render(records) {
    window.__lastRecords = records;
    const container = document.getElementById('records-container');
    if (!records.length) {
      container.innerHTML = '<div class="empty">No intake records yet. Start a call to see it appear here.</div>';
      return;
    }
    container.innerHTML = records.map(renderRecord).join('');
  }

  async function poll() {
    try {
      const res = await fetch('/api/records');
      const data = await res.json();
      render(data.records || []);
      document.getElementById('live-badge').textContent = 'live · polling every 3s';
    } catch (err) {
      document.getElementById('live-badge').textContent = 'connection error, retrying…';
      console.error('poll failed', err);
    }
  }

  poll();
  setInterval(poll, POLL_MS);
</script>
</body>
</html>
`;

export default router;
