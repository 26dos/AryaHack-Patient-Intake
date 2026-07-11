import { Router } from 'express';
import { listRecentRecords, getRecord, computeCompleteness } from '../lib/supabase.js';
import { FIELD_GROUPS, REQUIRED_P0_FIELD_KEYS, ALL_FIELD_KEYS } from '../lib/intakeSchema.js';
import { placeIntakeCall } from '../twilioClient.js';
import { config } from '../config.js';

const router = Router();

// POST /api/trigger-call — places a real outbound call to the Twilio-verified test patient
// number from the dashboard's "Call test patient" button. Deliberately does NOT accept an
// arbitrary destination from the request body: this endpoint is reachable over the public ngrok
// tunnel with no auth, and a Twilio trial account can only legally call verified numbers anyway,
// so locking it to the one configured number keeps this safe to leave exposed during a demo.
router.post('/api/trigger-call', async (req, res) => {
  try {
    if (!config.testPatientPhoneNumber) {
      res.status(400).json({ error: 'TEST_PATIENT_PHONE_NUMBER is not configured.' });
      return;
    }
    const call = await placeIntakeCall(config.testPatientPhoneNumber);
    res.json({ callSid: call.sid, to: config.testPatientPhoneNumber });
  } catch (err) {
    console.error('[dashboard] POST /api/trigger-call failed:', err);
    res.status(500).json({ error: err.message || 'Failed to place call' });
  }
});

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

// GET / — the front-desk dashboard page (inline HTML/CSS/JS, no build step). The intake
// schema (which fields exist, which groups are required) is injected server-side as
// window.__SCHEMA__ so the client never hardcodes a copy that could drift from
// server/src/lib/intakeSchema.js.
router.get('/', (req, res) => {
  const schemaJson = JSON.stringify({
    fieldGroups: FIELD_GROUPS,
    requiredKeys: REQUIRED_P0_FIELD_KEYS,
    allKeys: ALL_FIELD_KEYS,
  });
  res.type('html').send(DASHBOARD_HTML_HEAD + schemaJson + DASHBOARD_HTML_TAIL);
});

const DASHBOARD_HTML_HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Riverside Cardiology — Front Desk</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#E9EEF0; --surface:#FFFFFF; --surface-2:#F5F8F9;
    --ink:#10242E; --ink-2:#48606A; --ink-3:#8698A0;
    --line:#DBE4E7; --line-2:#EAF0F1;
    --teal:#0E7C86; --teal-deep:#0A5B63; --teal-soft:#E1F0F0; --teal-live:#15A3AE;
    --ready:#2C7A57; --ready-soft:#E2EFE8;
    --attn:#A9670A; --attn-soft:#F8EBD6;
    --alert:#BE3830; --alert-soft:#FAE5E3;
    --radius:10px; --radius-lg:16px;
    --shadow:0 1px 2px rgba(16,36,46,.04), 0 8px 24px rgba(16,36,46,.06);
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    font-family:'IBM Plex Sans',system-ui,sans-serif;
    background:var(--paper); color:var(--ink);
    -webkit-font-smoothing:antialiased; font-size:14px; line-height:1.5;
  }
  .mono{font-family:'IBM Plex Mono',monospace;font-feature-settings:"tnum"}
  button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
  :focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:4px}

  .app{display:grid;grid-template-rows:auto 1fr;height:100vh;min-height:0}

  .topbar{display:flex;align-items:center;gap:20px;padding:14px 22px;background:var(--surface);border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:11px}
  .brand .mark{width:30px;height:30px;border-radius:8px;background:var(--teal);display:grid;place-items:center;color:#fff;flex:none}
  .brand .mark svg{width:19px;height:19px}
  .brand h1{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0;line-height:1.15}
  .brand .sub{font-size:11.5px;color:var(--ink-3);letter-spacing:.02em}
  .topbar .date{margin-left:auto;font-size:12.5px;color:var(--ink-2)}
  .topbar .date .mono{color:var(--ink);font-weight:500}

  .callchip{display:flex;align-items:center;gap:10px;padding:6px 12px 6px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface-2);font-size:12px;color:var(--ink-3);transition:all .3s}
  .callchip .ecg{width:52px;height:20px;opacity:.35}
  .callchip.on{border-color:var(--teal-live);background:var(--teal-soft);color:var(--teal-deep);font-weight:500}
  .callchip.on .ecg{opacity:1}
  .callchip .dot{width:7px;height:7px;border-radius:50%;background:var(--ink-3)}
  .callchip.on .dot{background:var(--teal-live);animation:blink 1.1s infinite}
  @keyframes blink{50%{opacity:.25}}

  .main{display:grid;grid-template-columns:322px 1fr;min-height:0}

  .roster{background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .roster-head{padding:18px 20px 12px}
  .roster-head .eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}
  .roster-head h2{margin:3px 0 0;font-size:19px;font-weight:600;letter-spacing:-.02em}
  .roster-head .count{font-size:12px;color:var(--ink-2);margin-top:2px}
  .roster-head .count b{color:var(--attn);font-weight:600}
  .roster-list{overflow-y:auto;padding:4px 12px 16px;flex:1;min-height:0}
  .sectlabel{font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);padding:14px 8px 6px}
  .roster-empty{padding:24px 12px;color:var(--ink-3);font-size:12.5px;text-align:center}

  .prow{width:100%;text-align:left;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:11px 12px;border-radius:var(--radius);border:1px solid transparent;transition:background .15s;margin-bottom:2px}
  .prow:hover{background:var(--surface-2)}
  .prow.active{background:var(--teal-soft);border-color:#C9E4E4}
  .prow .time{font-size:12px;color:var(--ink-2);width:44px}
  .prow .who .nm{font-weight:600;font-size:13.5px;letter-spacing:-.01em}
  .prow .who .rsn{font-size:11.5px;color:var(--ink-3)}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap}
  .pill .d{width:6px;height:6px;border-radius:50%}
  .pill.ready{background:var(--ready-soft);color:var(--ready)} .pill.ready .d{background:var(--ready)}
  .pill.attn{background:var(--attn-soft);color:var(--attn)} .pill.attn .d{background:var(--attn)}
  .pill.live{background:var(--teal-soft);color:var(--teal-deep)} .pill.live .d{background:var(--teal-live);animation:blink 1.1s infinite}
  .pill.wait{background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line)} .pill.wait .d{background:var(--ink-3)}
  .pill.emergency{background:var(--alert-soft);color:var(--alert)} .pill.emergency .d{background:var(--alert);animation:blink 1.1s infinite}

  .record-wrap{overflow-y:auto;min-height:0;padding:22px 26px 90px}
  .record{max-width:760px;margin:0 auto}

  .rhead{display:flex;align-items:flex-start;gap:18px;margin-bottom:6px}
  .rhead .patient{flex:1}
  .rhead h2{margin:0;font-size:26px;font-weight:700;letter-spacing:-.025em}
  .rhead .meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:12.5px;color:var(--ink-2)}
  .rhead .meta .k{color:var(--ink-3);margin-right:5px}
  .progress-card{flex:none;width:150px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:13px 15px;box-shadow:var(--shadow);text-align:center}
  .progress-card .num{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1}
  .progress-card .num .of{font-size:15px;color:var(--ink-3);font-weight:500}
  .progress-card .lbl{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin-top:4px}
  .bar{height:4px;border-radius:2px;background:var(--line-2);margin-top:9px;overflow:hidden}
  .bar > i{display:block;height:100%;background:var(--teal);width:0;transition:width .5s cubic-bezier(.4,0,.2,1)}

  .phasestrip{display:none;align-items:center;gap:0;margin:16px 0 4px;padding:10px 4px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);overflow-x:auto}
  .phasestrip.show{display:flex}
  .ph{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ink-3);white-space:nowrap;flex:none}
  .ph .n{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--line);display:grid;place-items:center;font-size:9px;font-weight:600}
  .ph.done{color:var(--ready)} .ph.done .n{background:var(--ready);border-color:var(--ready);color:#fff}
  .ph.now{color:var(--teal-deep);font-weight:600} .ph.now .n{border-color:var(--teal-live);background:var(--teal-soft);color:var(--teal-deep)}
  .ph .sep{width:16px;height:1px;background:var(--line);margin:0 6px;flex:none}

  .banner{display:none;align-items:center;gap:11px;margin:18px 0 2px;padding:11px 15px;border-radius:var(--radius)}
  .banner.show{display:flex}
  .banner svg{width:18px;height:18px;flex:none}
  .banner .body{font-size:13px}
  .banner.alert{background:var(--alert-soft);border:1px solid #F0C9C5;border-left:3px solid var(--alert)}
  .banner.alert svg{color:var(--alert)} .banner.alert b{color:var(--alert)} .banner.alert .body{color:#7a2621}
  .banner.amber{background:var(--attn-soft);border:1px solid #EAD2A8;border-left:3px solid var(--attn)}
  .banner.amber svg{color:var(--attn)} .banner.amber b{color:var(--attn)} .banner.amber .body{color:#7a520a}

  .group{margin-top:22px}
  .group > h3{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:0 0 9px;display:flex;align-items:center;gap:8px}
  .group > h3 .ln{flex:1;height:1px;background:var(--line-2)}

  .field{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:13px 16px;margin-bottom:8px;box-shadow:var(--shadow);display:grid;grid-template-columns:1fr auto;gap:4px 14px;align-items:start;opacity:.45;transition:opacity .4s, box-shadow .4s, border-color .4s}
  .field.filled{opacity:1}
  .field.pending{opacity:.5}
  .field.just{animation:beat .7s cubic-bezier(.2,.7,.3,1)}
  @keyframes beat{0%{box-shadow:0 0 0 0 rgba(21,163,174,0)}18%{box-shadow:0 0 0 4px rgba(21,163,174,.18);border-color:var(--teal-live)}100%{box-shadow:var(--shadow)}}
  .field .flabel{font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--ink-3);grid-column:1/-1;margin-bottom:2px}
  .field .fval{font-size:14.5px;font-weight:500;color:var(--ink);align-self:center}
  .field .fval .sub{display:block;font-size:12.5px;font-weight:400;color:var(--ink-2);margin-top:1px}
  .field .fval.empty{color:var(--ink-3);font-weight:400;font-style:italic}

  .tag{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap;align-self:center}
  .tag svg{width:11px;height:11px}
  .tag.ok{background:var(--ready-soft);color:var(--ready)}
  .tag.declined{background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line)}
  .tag.confirm{background:var(--attn-soft);color:var(--attn)}
  .tag.wait{background:var(--surface-2);color:var(--ink-3)}

  .reqmark{display:inline-block;margin-left:8px;font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--attn);vertical-align:middle}
  .reqmark.opt{color:var(--ink-3)}
  .ready-flag{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:600}
  .ready-flag svg{width:13px;height:13px}
  .ready-flag.ok{background:var(--ready-soft);color:var(--ready)}
  .ready-flag.attn{background:var(--attn-soft);color:var(--attn)}
  .ready-flag.live{background:var(--teal-soft);color:var(--teal-deep)}
  .ready-flag.neutral{background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line)}
  .tag.reqmiss{background:var(--attn-soft);color:var(--attn)}
  .unverif{color:var(--attn);font-weight:600}

  .controls{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;background:var(--ink);color:#fff;padding:9px 10px 9px 18px;border-radius:999px;box-shadow:0 12px 40px rgba(16,36,46,.28);z-index:20}
  .controls .msg{font-size:12.5px;color:#B9C7CC;letter-spacing:.01em;max-width:340px}
  .controls .msg b{color:#fff;font-weight:600}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:9px 17px;border-radius:999px;font-size:13px;font-weight:600;letter-spacing:.01em;transition:transform .1s, background .2s}
  .btn:active{transform:scale(.97)}
  .btn.primary{background:var(--teal-live);color:#fff}
  .btn.primary:hover{background:#12b3bf}
  .btn.primary:disabled{background:#3a5560;color:#7e939a;cursor:default}
  .btn.ghost{background:rgba(255,255,255,.08);color:#cdd9dd}
  .btn.ghost:hover{background:rgba(255,255,255,.15)}
  .btn svg{width:15px;height:15px}

  @media (max-width:840px){.main{grid-template-columns:1fr}.roster{display:none}.rhead{flex-direction:column}.progress-card{width:100%}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2-6 4 12 2-6h6"/></svg></span>
      <div><h1>Riverside Cardiology</h1><div class="sub">Front desk · Intake · powered by Arya Health</div></div>
    </div>
    <div class="callchip" id="callchip">
      <span class="dot"></span>
      <svg class="ecg" viewBox="0 0 104 20" preserveAspectRatio="none" aria-hidden="true"><path d="M0 10 H18 l4 -7 4 14 4 -7 H52 l4 -7 4 14 4 -7 H104" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>
      <span id="callmsg">No active call</span>
    </div>
    <div class="date"><span id="clockday">—</span> · <span class="mono" id="clocktime">—</span></div>
  </header>

  <div class="main">
    <aside class="roster">
      <div class="roster-head">
        <div class="eyebrow">Live</div>
        <h2>Calls</h2>
        <div class="count" id="rostercount">Loading…</div>
      </div>
      <div class="roster-list" id="rosterlist"></div>
    </aside>

    <section class="record-wrap">
      <div class="record">
        <div class="rhead">
          <div class="patient">
            <h2 id="pname">—</h2>
            <div id="readyflag" class="ready-flag neutral"></div>
            <div class="meta">
              <span><span class="k">DOB</span><span class="mono" id="pdob">—</span></span>
              <span><span class="k">Appt</span><span id="pappt">—</span></span>
              <span><span class="k">Phone</span><span class="mono" id="pphone">—</span></span>
            </div>
          </div>
          <div class="progress-card">
            <div class="num"><span id="doneN">0</span><span class="of" id="totN">/0</span></div>
            <div class="lbl">Required resolved</div>
            <div class="bar"><i id="progbar"></i></div>
          </div>
        </div>

        <div class="phasestrip" id="phasestrip"></div>

        <div class="banner alert" id="allergybanner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
          <div class="body"><b>Allergy on file:</b> <span id="allergytext">—</span></div>
        </div>
        <div class="banner amber" id="noticebanner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
          <div class="body"><b id="noticelead">Notice</b> <span id="noticetext"></span></div>
        </div>

        <div id="groups"></div>
      </div>
    </section>
  </div>
</div>

<div class="controls">
  <span class="msg" id="ctrlmsg">Watching for calls…</span>
  <button class="btn primary" id="callbtn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13 1 .35 1.94.66 2.87a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.93.31 1.87.53 2.87.66A2 2 0 0 1 22 16.92z"/></svg>
    Call test patient
  </button>
  <button class="btn ghost" id="refreshbtn">Refresh now</button>
</div>

<script>
window.__SCHEMA__ =`;

const DASHBOARD_HTML_TAIL = `;

function $(sel) { return document.querySelector(sel); }

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function titleCase(key) {
  var words = String(key).split('_');
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w) continue;
    out.push(w.charAt(0).toUpperCase() + w.slice(1));
  }
  return out.join(' ');
}

function formatPhone(p) {
  if (!p) return '';
  var digits = p.indexOf('+1') === 0 ? p.slice(2) : p;
  if (digits.length === 10) {
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }
  return p;
}

function formatTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function isNegativeAllergy(v) {
  if (!v) return true;
  var s = String(v).toLowerCase();
  var negatives = ['none', 'no known', 'nka', 'not on any', 'no allerg', 'denies', 'no known drug'];
  for (var i = 0; i < negatives.length; i++) {
    if (s.indexOf(negatives[i]) === 0) return true;
  }
  return false;
}

var IC = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  ready: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13 1 .35 1.94.66 2.87a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.93.31 1.87.53 2.87.66A2 2 0 0 1 22 16.92z"/></svg>'
};

// ---------------------------------------------------------------------------------------------
// Schema-driven presentation layer. FIELD_REQUIRED / requiredKeys come from window.__SCHEMA__
// (injected server-side from intakeSchema.js) so this can never silently drift from the backend
// contract. GROUP_DEFS below is purely cosmetic layout/labels curated to match the design.
// ---------------------------------------------------------------------------------------------

var SCHEMA = window.__SCHEMA__;
var FIELD_REQUIRED = {};
for (var gi = 0; gi < SCHEMA.fieldGroups.length; gi++) {
  var sg = SCHEMA.fieldGroups[gi];
  for (var fi = 0; fi < sg.fields.length; fi++) {
    FIELD_REQUIRED[sg.fields[fi]] = !!sg.required;
  }
}

var FIELD_META = {
  full_name: { label: 'Full name' },
  date_of_birth: { label: 'Date of birth', mono: true },
  preferred_language: { label: 'Preferred language' },
  emergency_contact_name: { label: 'Contact' },
  emergency_contact_relationship: { label: 'Relationship' },
  emergency_contact_phone: { label: 'Phone', mono: true },
  insurance_payer_name: { label: 'Payer', unverified: true },
  insurance_member_id: { label: 'Member ID', mono: true, unverified: true },
  insurance_group_number: { label: 'Group number', mono: true, unverified: true },
  chief_complaint_text: { label: "In the patient's words" },
  chief_complaint_category: { label: 'Category' },
  medications: { label: 'Current medications' },
  allergies: { label: 'Drug allergies' },
  prior_conditions: { label: 'Ongoing conditions' },
  smoking_alcohol: { label: 'Social history', optional: true },
  occupation: { label: 'Occupation', optional: true },
  referring_provider_name: { label: 'Referring provider' }
};

function metaFor(key) {
  return FIELD_META[key] || { label: titleCase(key) };
}

var GROUP_DEFS = [
  { key: 'identity', label: 'Identity', kind: 'fields', fields: ['full_name', 'date_of_birth', 'preferred_language'] },
  { key: 'consent', label: 'Consent', kind: 'consent' },
  { key: 'chief_complaint', label: 'Reason for visit', kind: 'fields', fields: ['chief_complaint_text', 'chief_complaint_category'] },
  { key: 'medications', label: 'Medications', kind: 'fields', fields: ['medications'] },
  { key: 'allergies', label: 'Allergies', kind: 'fields', fields: ['allergies'] },
  { key: 'history', label: 'History', kind: 'fields', fields: ['prior_conditions', 'smoking_alcohol', 'occupation'] },
  { key: 'insurance', label: 'Insurance', kind: 'fields', fields: ['insurance_payer_name', 'insurance_member_id', 'insurance_group_number'] },
  { key: 'emergency_contact', label: 'Emergency contact', kind: 'contact', fields: ['emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'] },
  { key: 'pcp_referral', label: 'Referral', kind: 'fields', fields: ['referring_provider_name'] }
];

var KNOWN_FIELD_KEYS = {};
GROUP_DEFS.forEach(function (g) {
  (g.fields || []).forEach(function (k) { KNOWN_FIELD_KEYS[k] = true; });
});

var PHASE_DEFS = [
  { key: 'consent', label: 'Consent' },
  { key: 'chief_complaint', label: 'Reason' },
  { key: 'medications', label: 'Meds' },
  { key: 'allergies', label: 'Allergies' },
  { key: 'history', label: 'History' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'emergency_contact', label: 'Contact' },
  { key: 'recap', label: 'Recap' }
];

// ---------------------------------------------------------------------------------------------
// Field classification — maps our real captured/patient_declined/unable_to_capture states (plus
// "absent entirely") onto a visual tone, matching the PRD's "no silent data loss" contract: a
// declined field is a resolved terminal state, not an attention item; only unable_to_capture or a
// still-missing field on a call that has already ended needs front-desk follow-up.
// ---------------------------------------------------------------------------------------------

function hasUsableValue(entry) {
  return !!entry && entry.value !== null && entry.value !== undefined && entry.value !== '';
}

// "Cleanly resolved" = a real captured value, or an active decline — nothing left to do.
// unable_to_capture is a defined terminal state per the PRD (no silent blank), but it still
// represents a gap the front desk needs to close, so it does NOT count as cleanly resolved here.
// A tool call that claims state:"captured" with no value (seen in real Gemini output — the model
// occasionally marks a field resolved without actually recording anything) is treated the same as
// unable_to_capture: something needs the desk, it just isn't a clean success.
function isCleanlyResolved(entry) {
  if (!entry) return false;
  if (entry.state === 'captured') return hasUsableValue(entry);
  return entry.state === 'patient_declined';
}

function needsFollowUp(entry) {
  if (!entry) return true;
  if (entry.state === 'unable_to_capture') return true;
  if (entry.state === 'captured' && !hasUsableValue(entry)) return true;
  return false;
}

// A field has at least been "addressed" in conversation terms once it reaches any terminal state
// (including unable_to_capture) — used for phase-strip progression, which cares about whether the
// topic came up at all, not whether the desk still needs to follow up on it.
function hasBeenAddressed(entry) {
  return isCleanlyResolved(entry) || (!!entry && entry.state === 'unable_to_capture');
}

function classifyField(entry, required, callActive) {
  if (entry && entry.state === 'captured' && hasUsableValue(entry)) return 'ok';
  if (entry && entry.state === 'patient_declined') return 'declined';
  if (entry && entry.state === 'unable_to_capture') return required ? 'needsdesk' : 'unable';
  if (entry && entry.state === 'captured' && !hasUsableValue(entry)) return required ? 'needsdesk' : 'unable';
  if (callActive) return 'wait';
  return required ? 'needsdesk' : 'notstarted';
}

function tagHtml(tone, required) {
  if (tone === 'ok') return '<span class="tag ok">' + IC.check + ' Captured</span>';
  if (tone === 'declined') return '<span class="tag declined">Declined</span>';
  if (tone === 'needsdesk') return '<span class="tag reqmiss">' + (required ? 'Required' : 'Optional') + ' · needs desk</span>';
  if (tone === 'unable') return '<span class="tag declined">Unable to capture</span>';
  if (tone === 'wait') return '<span class="tag wait">' + (required ? 'Waiting…' : 'Optional') + '</span>';
  return '<span class="tag wait">Optional · not started</span>';
}

function valueContent(entry, def, tone) {
  if (tone === 'wait') return { html: 'Waiting for call…', empty: true };
  if (tone === 'notstarted') return { html: '—', empty: true };
  if (!hasUsableValue(entry)) {
    if (entry && entry.state === 'captured') return { html: 'Marked captured, but no value was recorded — confirm with patient', empty: true };
    if (tone === 'needsdesk') return { html: "Couldn't capture on the call", empty: true };
    if (tone === 'declined') return { html: 'Declined to share', empty: true };
    return { html: '—', empty: true };
  }
  var raw = escapeHtml(entry.value);
  var val = def.mono ? '<span class="mono">' + raw + '</span>' : raw;
  var subParts = [];
  if (def.unverified) subParts.push('self-reported · unverified');
  var sub = '';
  if (subParts.length) {
    var subInner = subParts.join(' · ');
    sub = def.unverified ? '<span class="sub"><span class="unverif">' + subInner + '</span></span>' : '<span class="sub">' + subInner + '</span>';
  }
  return { html: val + sub, empty: false };
}

// ---------------------------------------------------------------------------------------------
// DOM build (once) + paint (every poll / selection change)
// ---------------------------------------------------------------------------------------------

var groupsEl = $('#groups');
var fieldEls = [];
var selectedCallSid = null;
var latestRecords = [];
var lastValues = {};

function makeFieldEl(label, required) {
  var el = document.createElement('div');
  el.className = 'field';
  el.innerHTML = '<div class="flabel">' + escapeHtml(label) + '<span class="reqmark' + (required ? '' : ' opt') + '">' + (required ? 'Required' : 'Optional') + '</span></div>' +
    '<div class="fval" data-slot>—</div><div data-tag></div>';
  return { el: el, slot: el.querySelector('[data-slot]'), tag: el.querySelector('[data-tag]') };
}

function buildDetailDOM() {
  groupsEl.innerHTML = '';
  fieldEls = [];
  GROUP_DEFS.forEach(function (g) {
    var wrap = document.createElement('div');
    wrap.className = 'group';
    wrap.innerHTML = '<h3>' + escapeHtml(g.label) + '<span class="ln"></span></h3>';
    if (g.kind === 'consent') {
      var ce = makeFieldEl('Recording & sharing consent', true);
      wrap.appendChild(ce.el);
      fieldEls.push({ el: ce.el, slot: ce.slot, tag: ce.tag, groupKey: g.key, kind: 'consent', required: true });
    } else if (g.kind === 'contact') {
      var xe = makeFieldEl('Contact', true);
      wrap.appendChild(xe.el);
      fieldEls.push({ el: xe.el, slot: xe.slot, tag: xe.tag, groupKey: g.key, kind: 'contact', required: true, fields: g.fields });
    } else {
      g.fields.forEach(function (key) {
        var meta = metaFor(key);
        var required = FIELD_REQUIRED[key] === true && !meta.optional;
        var fe = makeFieldEl(meta.label, required);
        wrap.appendChild(fe.el);
        fieldEls.push({ el: fe.el, slot: fe.slot, tag: fe.tag, groupKey: g.key, kind: 'field', fieldKey: key, def: meta, required: required });
      });
    }
    groupsEl.appendChild(wrap);
  });
  var extra = document.createElement('div');
  extra.className = 'group';
  extra.id = 'extra-group';
  extra.style.display = 'none';
  groupsEl.appendChild(extra);
}

function trackChange(callSid, key, serialized) {
  var cacheKey = callSid + '::' + key;
  var prev = lastValues[cacheKey];
  lastValues[cacheKey] = serialized;
  return prev !== undefined && prev !== serialized;
}

function pulse(el, changed) {
  if (changed) {
    el.classList.add('just');
    setTimeout(function () { el.classList.remove('just'); }, 750);
  }
}

function setProgress(done, total) {
  $('#doneN').textContent = done;
  $('#totN').textContent = '/' + total;
  $('#progbar').style.width = (total ? (done / total * 100) : 0) + '%';
}

// A required field "needs the desk" if the call has ended (or was never a live call) and that
// field is still unable_to_capture or entirely absent. While the call is still in progress this
// is never counted — the patient may simply not have gotten to that question yet.
function needsDeskKeys(record) {
  var active = record.call_status === 'in_progress';
  var out = [];
  if (active) return out;
  SCHEMA.requiredKeys.forEach(function (key) {
    var entry = record.fields ? record.fields[key] : null;
    if (needsFollowUp(entry)) out.push(key);
  });
  return out;
}

function resolvedRequiredCount(record) {
  var n = 0;
  SCHEMA.requiredKeys.forEach(function (key) {
    var entry = record.fields ? record.fields[key] : null;
    if (isCleanlyResolved(entry)) n++;
  });
  return n;
}

function hasAnyData(record) {
  if (record.consent_given) return true;
  var fields = record.fields || {};
  return Object.keys(fields).length > 0;
}

function isGroupResolved(record, groupKey) {
  if (groupKey === 'consent') return record.consent_given === true;
  var def = GROUP_DEFS.filter(function (g) { return g.key === groupKey; })[0];
  if (!def) return true;
  var keys = def.fields || [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (FIELD_REQUIRED[key] === false) continue; // optional fields don't gate phase progress
    var entry = record.fields ? record.fields[key] : null;
    if (!hasBeenAddressed(entry)) return false;
  }
  return true;
}

function computePhaseIndex(record) {
  for (var i = 0; i < PHASE_DEFS.length - 1; i++) {
    if (!isGroupResolved(record, PHASE_DEFS[i].key)) return i;
  }
  return record.call_status === 'completed' ? PHASE_DEFS.length - 1 : PHASE_DEFS.length - 2;
}

function renderPhaseStrip(record) {
  var strip = $('#phasestrip');
  if (!hasAnyData(record) && record.call_status !== 'in_progress') {
    strip.classList.remove('show');
    strip.innerHTML = '';
    return;
  }
  strip.classList.add('show');
  var idx = computePhaseIndex(record);
  var html = '';
  for (var i = 0; i < PHASE_DEFS.length; i++) {
    var cls = i < idx ? 'done' : (i === idx ? 'now' : '');
    var inner = i < idx ? IC.check : String(i + 1);
    html += '<span class="ph ' + cls + '"><span class="n">' + inner + '</span>' + escapeHtml(PHASE_DEFS[i].label) + '</span>';
    if (i < PHASE_DEFS.length - 1) html += '<span class="sep"></span>';
  }
  strip.innerHTML = html;
}

function renderBanners(record) {
  var allergyEntry = record.fields ? record.fields.allergies : null;
  var ab = $('#allergybanner');
  if (allergyEntry && allergyEntry.state === 'captured' && allergyEntry.value && !isNegativeAllergy(allergyEntry.value)) {
    $('#allergytext').textContent = String(allergyEntry.value);
    ab.classList.add('show');
  } else {
    ab.classList.remove('show');
  }

  var nb = $('#noticebanner');
  var missingKeys = needsDeskKeys(record);
  var notice = null;
  if (record.call_status === 'emergency_escalated') {
    notice = { lead: 'Emergency escalation —', text: 'the call was ended and the patient was told to hang up and call 911 or go to the nearest ER.' };
  } else if (record.call_status === 'voicemail') {
    notice = { lead: 'Reached voicemail.', text: 'Left a callback message. No intake fields were captured — retry the call or complete at check-in.' };
  } else if (record.call_status === 'dropped') {
    var labels1 = missingKeys.map(function (k) { return metaFor(k).label; });
    notice = { lead: "Call didn't complete.", text: 'The call ended early.' + (labels1.length ? ' Needs the desk: ' + labels1.join(', ') + '.' : '') };
  } else if (record.call_status === 'completed' && missingKeys.length) {
    var labels2 = missingKeys.map(function (k) { return metaFor(k).label; });
    notice = { lead: labels2.length > 1 ? 'Required fields need the desk:' : 'A required field needs the desk:', text: labels2.join(', ') + " couldn't be captured on the call." };
  }
  if (notice) {
    $('#noticelead').textContent = notice.lead;
    $('#noticetext').textContent = notice.text;
    nb.classList.add('show');
  } else {
    nb.classList.remove('show');
  }
}

function renderReadyFlag(record) {
  var el = $('#readyflag');
  if (record.call_status === 'in_progress') {
    el.className = 'ready-flag live';
    el.innerHTML = 'Call in progress · ' + resolvedRequiredCount(record) + '/' + SCHEMA.requiredKeys.length + ' resolved so far';
    return;
  }
  if (!hasAnyData(record)) {
    el.className = 'ready-flag neutral';
    el.textContent = 'Waiting for call';
    return;
  }
  var missing = needsDeskKeys(record);
  if (missing.length === 0) {
    el.className = 'ready-flag ok';
    el.innerHTML = IC.ready + ' Ready to check in — all required resolved';
  } else {
    el.className = 'ready-flag attn';
    el.innerHTML = IC.warn + ' ' + missing.length + ' required field' + (missing.length > 1 ? 's' : '') + ' need' + (missing.length > 1 ? '' : 's') + ' the desk';
  }
}

function renderExtraFields(record) {
  var extra = $('#extra-group');
  var fields = record.fields || {};
  var leftover = Object.keys(fields).filter(function (k) { return !KNOWN_FIELD_KEYS[k]; });
  if (!leftover.length) {
    extra.style.display = 'none';
    extra.innerHTML = '';
    return;
  }
  extra.style.display = '';
  var html = '<h3>Additional information<span class="ln"></span></h3>';
  leftover.forEach(function (key) {
    var entry = fields[key];
    var val = entry && entry.value !== null && entry.value !== undefined ? escapeHtml(entry.value) : '—';
    html += '<div class="field filled"><div class="flabel">' + escapeHtml(titleCase(key)) + '</div>' +
      '<div class="fval">' + val + '</div><div>' + tagHtml(entry ? classifyField(entry, false, false) : 'notstarted', false) + '</div></div>';
  });
  extra.innerHTML = html;
}

function paintFieldEl(fe, record, callActive) {
  var tone, contentHtml, empty, changed, required;
  if (fe.kind === 'consent') {
    required = true;
    var serialized = JSON.stringify([record.consent_given, record.consent_logged_at]);
    changed = trackChange(record.call_sid, '__consent__', serialized);
    if (record.consent_given === true) {
      tone = 'ok';
      contentHtml = 'Given<span class="sub">' + escapeHtml(formatTime(record.consent_logged_at)) + ' · verbal</span>';
      empty = false;
    } else if (callActive) {
      tone = 'wait'; contentHtml = 'Waiting for call…'; empty = true;
    } else {
      tone = 'needsdesk'; contentHtml = 'Not captured'; empty = true;
    }
  } else if (fe.kind === 'contact') {
    required = true;
    var nameE = record.fields ? record.fields.emergency_contact_name : null;
    var relE = record.fields ? record.fields.emergency_contact_relationship : null;
    var phoneE = record.fields ? record.fields.emergency_contact_phone : null;
    changed = trackChange(record.call_sid, '__contact__', JSON.stringify([nameE, relE, phoneE]));
    var allCaptured = hasUsableValue(nameE) && hasUsableValue(relE) && hasUsableValue(phoneE);
    var allDeclined = [nameE, relE, phoneE].every(function (e) { return e && e.state === 'patient_declined'; });
    var anyCaptured = [nameE, relE, phoneE].some(function (e) { return hasUsableValue(e); });
    if (allCaptured) {
      tone = 'ok'; empty = false;
      contentHtml = escapeHtml(nameE.value) + '<span class="sub">' + escapeHtml(relE.value) + ' · <span class="mono">' + escapeHtml(phoneE.value) + '</span></span>';
    } else if (allDeclined) {
      tone = 'declined'; empty = true; contentHtml = 'Declined to share';
    } else if (anyCaptured) {
      tone = 'needsdesk'; empty = false;
      var got = [nameE, relE, phoneE].filter(function (e) { return hasUsableValue(e); }).map(function (e) { return e.value; }).join(' · ');
      contentHtml = escapeHtml(got) + '<span class="sub">Some contact details still needed</span>';
    } else if (callActive) {
      tone = 'wait'; empty = true; contentHtml = 'Waiting for call…';
    } else {
      tone = 'needsdesk'; empty = true; contentHtml = "Couldn't capture on the call";
    }
  } else {
    required = fe.required;
    var entry = record.fields ? record.fields[fe.fieldKey] : null;
    changed = trackChange(record.call_sid, fe.fieldKey, JSON.stringify(entry || null));
    tone = classifyField(entry, required, callActive);
    var vc = valueContent(entry, fe.def, tone);
    contentHtml = vc.html; empty = vc.empty;
  }
  fe.slot.classList.toggle('empty', empty);
  fe.slot.innerHTML = contentHtml;
  fe.tag.innerHTML = tagHtml(tone, required);
  fe.el.classList.toggle('filled', !empty);
  fe.el.classList.toggle('pending', tone === 'wait');
  pulse(fe.el, changed);
}

function callStatusLabel(status) {
  if (status === 'in_progress') return 'Call in progress';
  if (status === 'completed') return 'Call complete';
  if (status === 'voicemail') return 'Left voicemail';
  if (status === 'dropped') return 'Call dropped';
  if (status === 'emergency_escalated') return 'Emergency escalation';
  return 'No active call';
}

function updateCallChip(record) {
  var chip = $('#callchip');
  var msg = $('#callmsg');
  if (!record) { chip.classList.remove('on'); msg.textContent = 'No active call'; return; }
  if (record.call_status === 'in_progress') {
    chip.classList.add('on'); msg.textContent = 'Call in progress';
  } else {
    chip.classList.remove('on'); msg.textContent = callStatusLabel(record.call_status);
  }
}

function displayName(record) {
  var entry = record.fields ? record.fields.full_name : null;
  if (entry && entry.state === 'captured' && entry.value) return String(entry.value);
  return formatPhone(record.phone_number) || 'Unknown caller';
}

function displayReason(record) {
  var entry = record.fields ? record.fields.chief_complaint_text : null;
  if (entry && entry.state === 'captured' && entry.value) {
    var v = String(entry.value);
    return v.length > 42 ? v.slice(0, 39) + '…' : v;
  }
  if (record.call_status === 'in_progress') return 'Intake in progress…';
  if (record.call_status === 'voicemail') return 'Left voicemail';
  if (record.call_status === 'dropped') return 'Call dropped early';
  if (record.call_status === 'emergency_escalated') return 'Emergency — told to call 911';
  return 'Pre-visit intake';
}

function paintDetail(record) {
  if (!record) {
    $('#pname').textContent = 'No calls yet';
    $('#pdob').textContent = '—'; $('#pappt').textContent = '—'; $('#pphone').textContent = '—';
    $('#readyflag').className = 'ready-flag neutral';
    $('#readyflag').textContent = 'Place a call to see it appear here';
    $('#phasestrip').classList.remove('show'); $('#phasestrip').innerHTML = '';
    $('#allergybanner').classList.remove('show'); $('#noticebanner').classList.remove('show');
    setProgress(0, SCHEMA.requiredKeys.length);
    fieldEls.forEach(function (fe) {
      fe.slot.classList.add('empty'); fe.slot.textContent = 'Waiting for call…';
      fe.tag.innerHTML = tagHtml('wait', fe.required);
      fe.el.classList.remove('filled'); fe.el.classList.add('pending');
    });
    $('#extra-group').style.display = 'none';
    updateCallChip(null);
    $('#ctrlmsg').innerHTML = 'No intake calls yet — place a call to see it appear here';
    return;
  }
  var callActive = record.call_status === 'in_progress';
  $('#pname').textContent = displayName(record);
  $('#pdob').textContent = (record.fields && record.fields.date_of_birth && record.fields.date_of_birth.value) || '—';
  $('#pappt').textContent = record.appointment_datetime || '—';
  $('#pphone').textContent = formatPhone(record.phone_number) || '—';

  setProgress(resolvedRequiredCount(record), SCHEMA.requiredKeys.length);
  renderReadyFlag(record);
  renderPhaseStrip(record);
  renderBanners(record);
  renderExtraFields(record);
  fieldEls.forEach(function (fe) { paintFieldEl(fe, record, callActive); });
  updateCallChip(record);

  var name = displayName(record);
  if (callActive) {
    $('#ctrlmsg').innerHTML = '<b>' + escapeHtml(name) + '</b> · call connected · ' + resolvedRequiredCount(record) + '/' + SCHEMA.requiredKeys.length + ' required';
  } else {
    var missing = needsDeskKeys(record);
    var msg = '<b>' + escapeHtml(name) + '</b> · ' + callStatusLabel(record.call_status);
    if (hasAnyData(record)) msg += ' · ' + resolvedRequiredCount(record) + '/' + SCHEMA.requiredKeys.length + ' required';
    if (missing.length) msg += ' · ' + missing.length + ' to confirm';
    $('#ctrlmsg').innerHTML = msg;
  }
}

// ---------------------------------------------------------------------------------------------
// Roster (sidebar) — built entirely from real records returned by GET /api/records. There is no
// appointment-scheduling data source in this build, so "today's calls" is simply every intake
// record the server knows about, most-recently-updated first (matches listRecentRecords()).
// ---------------------------------------------------------------------------------------------

function statusOf(record) {
  if (record.call_status === 'emergency_escalated') return 'emergency';
  if (record.call_status === 'in_progress') return 'live';
  if (record.call_status === 'voicemail') return 'voicemail';
  if (record.call_status === 'dropped') return 'dropped';
  if (record.call_status === 'completed') return needsDeskKeys(record).length > 0 ? 'attn' : 'ready';
  return 'wait';
}

function pillFor(status) {
  var map = {
    ready: ['ready', 'Ready'],
    attn: ['attn', 'Needs attention'],
    live: ['live', 'On call now'],
    wait: ['wait', 'Not started'],
    emergency: ['emergency', 'Emergency'],
    voicemail: ['wait', 'Voicemail'],
    dropped: ['wait', 'Call dropped']
  };
  var m = map[status] || ['wait', status];
  return '<span class="pill ' + m[0] + '"><span class="d"></span>' + escapeHtml(m[1]) + '</span>';
}

function rosterRow(record, status) {
  return '<button class="prow" data-id="' + escapeHtml(record.call_sid) + '">' +
    '<span class="time mono">' + escapeHtml(formatTime(record.created_at)) + '</span>' +
    '<span class="who"><span class="nm">' + escapeHtml(displayName(record)) + '</span><br><span class="rsn">' + escapeHtml(displayReason(record)) + '</span></span>' +
    '<span class="stat">' + pillFor(status) + '</span></button>';
}

function renderRoster(records) {
  var list = $('#rosterlist');
  if (!records.length) {
    list.innerHTML = '<div class="roster-empty">No intake calls yet.<br>Place a call to see it appear here.</div>';
    $('#rostercount').textContent = 'No calls yet';
    return;
  }
  var withStatus = records.map(function (r) { return { record: r, status: statusOf(r) }; });
  var attn = withStatus.filter(function (r) { return r.status === 'emergency' || r.status === 'attn' || r.status === 'live'; });
  var ready = withStatus.filter(function (r) { return r.status === 'ready'; });
  var other = withStatus.filter(function (r) { return r.status === 'wait' || r.status === 'voicemail' || r.status === 'dropped'; });

  var html = '';
  if (attn.length) html += '<div class="sectlabel">Needs attention</div>' + attn.map(function (r) { return rosterRow(r.record, r.status); }).join('');
  if (ready.length) html += '<div class="sectlabel">Ready for check-in</div>' + ready.map(function (r) { return rosterRow(r.record, r.status); }).join('');
  if (other.length) html += '<div class="sectlabel">Other calls</div>' + other.map(function (r) { return rosterRow(r.record, r.status); }).join('');
  list.innerHTML = html;

  list.querySelectorAll('.prow').forEach(function (b) {
    b.addEventListener('click', function () { selectPatient(b.getAttribute('data-id')); });
  });
  list.querySelectorAll('.prow').forEach(function (b) {
    if (b.getAttribute('data-id') === selectedCallSid) b.classList.add('active');
  });

  $('#rostercount').innerHTML = '<b>' + attn.length + ' need attention</b> · ' + ready.length + ' ready';
}

function selectPatient(callSid) {
  selectedCallSid = callSid;
  document.querySelectorAll('.prow').forEach(function (r) { r.classList.toggle('active', r.getAttribute('data-id') === callSid); });
  var record = latestRecords.filter(function (r) { return r.call_sid === callSid; })[0] || null;
  paintDetail(record);
}

// ---------------------------------------------------------------------------------------------
// Clock + polling
// ---------------------------------------------------------------------------------------------

function tickClock() {
  var now = new Date();
  $('#clockday').textContent = now.toLocaleDateString(undefined, { weekday: 'long' });
  $('#clocktime').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

async function poll() {
  try {
    var res = await fetch('/api/records');
    var data = await res.json();
    latestRecords = data.records || [];
    renderRoster(latestRecords);
    if (!selectedCallSid || !latestRecords.some(function (r) { return r.call_sid === selectedCallSid; })) {
      var live = latestRecords.filter(function (r) { return r.call_status === 'in_progress'; })[0];
      selectedCallSid = (live || latestRecords[0] || {}).call_sid || null;
      document.querySelectorAll('.prow').forEach(function (r) { r.classList.toggle('active', r.getAttribute('data-id') === selectedCallSid); });
    }
    var record = latestRecords.filter(function (r) { return r.call_sid === selectedCallSid; })[0] || null;
    paintDetail(record);
  } catch (err) {
    console.error('[dashboard] poll failed', err);
  }
}

async function triggerCall() {
  var btn = $('#callbtn');
  btn.disabled = true;
  var originalHtml = btn.innerHTML;
  btn.innerHTML = 'Calling…';
  try {
    var res = await fetch('/api/trigger-call', { method: 'POST' });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to place call');
    $('#ctrlmsg').innerHTML = 'Call placed to test patient — <b>ringing now</b>';
    await poll();
  } catch (err) {
    $('#ctrlmsg').textContent = 'Could not place call: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

buildDetailDOM();
paintDetail(null);
tickClock();
setInterval(tickClock, 1000);
poll();
setInterval(poll, 3000);
$('#refreshbtn').addEventListener('click', poll);
$('#callbtn').addEventListener('click', triggerCall);
</script>
</body>
</html>
`;

export default router;

