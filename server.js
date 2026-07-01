#!/usr/bin/env node
/**
 * Robert Loop Health Dashboard
 * 
 * Monitors Robert's agent loop health: cron jobs, progression signals,
 * failure patterns, and session metrics.
 * 
 * Data sources:
 * - OpenClaw gateway API (cron status)
 * - ~/.openclaw/workspace/metrics/loop-metrics.md
 * - ~/.openclaw/workspace/code-standards/failure-mode-log.md
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3090;
const REFRESH_MS = 30000;
const GATEWAY_PORT = process.env.GATEWAY_PORT || 34567;
const WORKSPACE = process.env.WORKSPACE || '/home/robert/.openclaw/workspace';

// Repo URL mapping for GitHub links
const ISSUE_BASE_URL = 'https://github.com/yellow-house-studio/studywise-api/issues';
const PR_BASE_URL = 'https://github.com/yellow-house-studio/studywise-api/pull';

// ─── Gateway API ──────────────────────────────────────────────────────────────

function httpGet(port, path_, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.HOST_IP || '127.0.0.1',
      port: port,
      path: path_,
      method: 'GET',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      timeout: 5000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'parse error', raw: data.slice(0, 100) }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function execSync(cmd) {
  try {
    const { execSync: _exec } = require('child_process');
    return _exec(cmd, { timeout: 10000, encoding: 'utf8' });
  } catch (e) {
    return null;
  }
}

async function getGatewayCronJobs() {
  // Use OpenClaw CLI for reliable cron job data
  const output = execSync('openclaw cron list --json 2>/dev/null');
  if (!output) return [];
  try {
    const data = JSON.parse(output);
    const jobs = data.jobs || [];
    const DEV_WORKFLOW = [
      'development-planning-cron',
      'development-implementation-cron',
      'development-ai-review-cron',
      'development-create-pr-cron',
      'development-fix-pr-cron',
      'manual-pr-merge',
      'Run the pr-review-pick skill to find the next open PR needi…',
      'Run the plan-review-pick skill to find the next issue needi…',
      'Run the post-merge-pick skill to find the next post-merge t…'
    ];
    return jobs
    .filter(j => DEV_WORKFLOW.includes(j.name))
    .map(j => ({
      name: (j.name || '').substring(0, 60),
      description: j.description || '',
      enabled: j.enabled,
      lastRun: j.state?.lastRunAtMs,
      lastRunStatus: j.state?.lastRunStatus,
      nextRun: j.state?.nextRunAtMs,
      consecutiveFailures: j.state?.consecutiveErrors || 0,
      lastDuration: j.state?.lastDurationMs,
      status: j.status
    }));
  } catch {
    return [];
  }
}

// ─── File Parsing ─────────────────────────────────────────────────────────────

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseMetrics() {
  const file = readFile(path.join(WORKSPACE, 'metrics/loop-metrics.md'));
  if (!file) return { sections: [], progressionSignals: [], lastRun: null, selfCorrectionRate: null };

  // Read METRICS comment: <!-- METRICS: quickSessions=N hardSessions=N totalIssues=N -->
  const metricsMatch = file.match(/<!-- METRICS: quickSessions=(\d+) hardSessions=(\d+) totalIssues=(\d+) -->/);
  const quickSessions = metricsMatch ? parseInt(metricsMatch[1]) : 0;
  const hardSessions = metricsMatch ? parseInt(metricsMatch[2]) : 0;
  const totalSessions = metricsMatch ? parseInt(metricsMatch[3]) : 0;
  const selfCorrectionRate = totalSessions > 0 ? Math.round((quickSessions / totalSessions) * 100) : null;

  // Parse sections from Session Detail headings (last 20)
  const fileLines = file.split('\n');
  const sections = [];
  let current = null;
  for (const line of fileLines) {
    const m = line.match(/^#{3} Issue #(\d+) — (.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1], issueNum: m[1], repo: m[2], sessions: null, progressionSignals: [], notes: '' };
    }
  }
  if (current) sections.push(current);

  // Parse progression signals from Progression Signals section
  const progressionSignals = [];
  let inProg = false;
  for (const line of fileLines) {
    if (line.startsWith('## Progression Signals')) { inProg = true; continue; }
    if (inProg && line.startsWith('## ')) break;
    if (inProg && line.startsWith('| ')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 5 && cols[0] !== 'Date') {
        progressionSignals.push({ date: cols[0], issue: cols[1].replace('#',''), sessions: cols[3] });
      }
    }
  }

  return { sections, progressionSignals, lastRun: null, selfCorrectionRate, quickSessions, hardSessions, totalSessions };
}

async function getConvergenceRate() {
  try {
    const metricsFile = readFile(path.join(WORKSPACE, 'metrics/loop-metrics.md'));
    if (!metricsFile) return null;

    // Read total issues from METRICS comment
    const metricsMatch = metricsFile.match(/<!-- METRICS: quickSessions=(\d+) hardSessions=(\d+) totalIssues=(\d+) -->/);
    const totalIssues = metricsMatch ? parseInt(metricsMatch[3]) : 0;

    // Count issues with at least 1 completion from Issue Summary table
    // Format: | Date | #XXX | repo | Starts | Completions | Errors | Skips |
    const tableLines = metricsFile.split('\n');
    let completedIssues = 0;
    for (const line of tableLines) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      // cols: ['', 'Date', '#XXX', 'repo', 'Starts', 'Completions', 'Errors', 'Skips', '']
      // We need cols[5] = Completions (0-indexed)
      if (cols.length >= 6 && cols[1] && cols[1].startsWith('#')) {
        const dones = parseInt(cols[4]) || 0;
        if (dones >= 1) completedIssues++;
      }
    }

    const rate = totalIssues > 0
      ? Math.round((completedIssues / totalIssues) * 100)
      : null;
    return { convergenceRate: rate, completedIssues, totalIssues };
  } catch(e) {
    console.error('getConvergenceRate error:', e.message);
    return null;
  }
}

function parseFailureLog() {
  const file = readFile(path.join(WORKSPACE, 'code-standards/failure-mode-log.md'));
  if (!file) return { entries: [], recent: [], bySeverity: { high: 0, medium: 0, low: 0 } };

  const lines = file.split('\n');
  const entries = [];
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('| Date')) { inTable = true; continue; }
    if (!inTable || !line.startsWith('|') || line.includes('---')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length >= 8) {
      entries.push({
        date: cols[0],
        issue: cols[1],
        pattern: cols[2],
        layer: cols[3],
        gate: cols[4],
        type: cols[5],
        severity: cols[6],
        notes: cols[7]?.substring(0, 60)
      });
    }
  }

  const recent = entries.slice(0, 10);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const e of entries) {
    const s = e.severity?.toLowerCase();
    if (s === 'high') bySeverity.high++;
    else if (s === 'medium') bySeverity.medium++;
    else if (s === 'low') bySeverity.low++;
  }

  return { entries, recent, bySeverity, total: entries.length };
}

function parsePlanningGate() {
  const file = readFile(path.join(WORKSPACE, 'metrics/planning-gate-metrics.md'));
  if (!file) return null;

  const lines = file.split('\n');
  let direct = null, iterations = null, pending = null, noPlan = null;
  let updated = null;
  let recentDirect = [];
  let recentIterations = [];

  for (const line of lines) {
    if (line.startsWith('*Generated:')) {
      updated = line.replace('*Generated:', '').trim();
    }
    const m = line.match(/\| \*\*Direct approvals.*\| (\d+) \|/);
    if (m) direct = parseInt(m[1]);
    const mi = line.match(/\| \*\*Required iteration.*\| (\d+) \|/);
    if (mi) iterations = parseInt(mi[1]);
    const mp = line.match(/\| \*\*Not yet past Planning.*\| (\d+) \|/);
    if (mp) pending = parseInt(mp[1]);
    const mn = line.match(/\| \*\*No plan comment found.*\| (\d+) \|/);
    if (mn) noPlan = parseInt(mn[1]);
  }

  const total = (direct || 0) + (iterations || 0);
  const directPct = total > 0 ? Math.round((direct || 0) / total * 100) : 0;

  // Parse tables
  let inDirect = false, inIteration = false;
  for (const line of lines) {
    if (line.includes('## Direct Approvals')) { inDirect = true; inIteration = false; continue; }
    if (line.includes('## Required Iteration')) { inDirect = false; inIteration = true; continue; }
    if (line.includes('## Not Yet Past Planning')) { inDirect = false; inIteration = false; continue; }
    if (line.startsWith('---') || line.startsWith('#')) { inDirect = false; inIteration = false; continue; }

    const row = line.match(/^\| ([^|]+) \| #(\d+) /);
    if (row && inDirect) {
      recentDirect.push({ date: row[1].trim(), issue: row[2] });
    }
    if (row && inIteration) {
      const fbMatch = line.match(/\| (\d{4}-\d{2}-\d{2}): ([^|]+)/);
      recentIterations.push({
        date: row[1].trim(),
        issue: row[2],
        feedback: fbMatch ? fbMatch[2].trim().substring(0, 60) : ''
      });
    }
  }

  return {
    direct: direct || 0,
    iterations: iterations || 0,
    pending: pending || 0,
    noPlan: noPlan || 0,
    total,
    directPct,
    updated,
    recentDirect: recentDirect.slice(0, 8),
    recentIterations: recentIterations.slice(0, 5)
  };
}

// ─── API Endpoint ─────────────────────────────────────────────────────────────

async function handleApi(res) {
  try {
    const [cronJobs, metrics, failures, convergence, planningGate] = await Promise.all([
      getGatewayCronJobs().catch(() => []),
      Promise.resolve(parseMetrics()),
      Promise.resolve(parseFailureLog()),
      getConvergenceRate().catch(() => null),
      Promise.resolve(parsePlanningGate())
    ]);


    const data = {
      timestamp: new Date().toISOString(),
      cronJobs,
      metrics: { ...metrics, ...convergence },
      failures,
      planningGate,
      gateway: { port: GATEWAY_PORT, connected: !cronJobs.error }
    };

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data, null, 2));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── HTML Page ────────────────────────────────────────────────────────────────

function render(html) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Robert — Loop Health Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 20px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 20px; color: #f8fafc; }
  h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  h3 { font-size: 14px; font-weight: 600; color: #e2e8f0; margin-bottom: 6px; }
  
  .grid { display: grid; grid-template-columns: 320px 1fr; gap: 20px; align-items: start; }
  .right-panels { display: flex; flex-direction: column; gap: 20px; }
  .right-panels .card { margin-bottom: 0; }
  .cron-panel { max-height: calc(100vh - 100px); overflow-y: auto; }
  .right-panels .panel-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .right-panels .panel-row .card { flex: 1; min-width: 200px; }
  .card { background:#1a1d27; border-radius: 12px; padding: 20px; border: 1px solid #2d3348; }
  .card-full { grid-column: 1 / -1; }
  
  .status-ok { color: #22c55e; }
  .status-error { color: #ef4444; }
  .status-warn { color: #f59e0b; }
  .status-disabled { color: #64748b; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .badge-ok { background: #22c55e20; color: #22c55e; }
  .badge-error { background: #ef444420; color: #ef4444; }
  .badge-warn { background: #f59e0b20; color: #f59e0b; }
  .badge-disabled { background: #64748b20; color: #64748b; }
  
  .cron-list { display: flex; flex-direction: column; gap: 8px; }
  .cron-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #13161f; border-radius: 8px; border-left: 3px solid #64748b; }
  .cron-item.ok { border-left-color: #22c55e; }
  .cron-item.error { border-left-color: #ef4444; }
  .cron-item.warn { border-left-color: #f59e0b; }
  .cron-name { font-size: 13px; font-weight: 500; }
  .cron-meta { font-size: 11px; color: #64748b; }
  
  .table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .table th { text-align: left; padding: 8px 10px; color: #64748b; font-size: 11px; text-transform: uppercase; border-bottom: 1px solid #2d3348; }
  .table td { padding: 8px 10px; border-bottom: 1px solid #1e2330; }
  .table tr:last-child td { border-bottom: none; }
  .table tr:hover td { background: #13161f; }
  
  .metric-row { display: flex; gap: 16px; margin-bottom: 12px; }
  .metric { flex: 1; background: #13161f; border-radius: 8px; padding: 14px; text-align: center; }
  .metric-value { font-size: 28px; font-weight: 700; }
  .metric-label { font-size: 11px; color: #64748b; text-transform: uppercase; margin-top: 4px; }
  
  .sig-ok { border-left: 3px solid #22c55e; }
  .sig-warn { border-left: 3px solid #f59e0b; }
  
  .updated { font-size: 11px; color: #475569; margin-top: 16px; text-align: right; }
  .no-data { color: #475569; font-style: italic; font-size: 13px; padding: 20px; text-align: center; }
  
  .refresh { font-size: 12px; color: #475569; }
  .refresh-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  /* Responsive: Tablet */
  @media (max-width: 1024px) {
    .grid { grid-template-columns: 260px 1fr !important; }
  }

  /* Responsive: Mobile */
  @media (max-width: 768px) {
    body, .grid { box-sizing: border-box; } .grid { padding-right: 16px; }
    .grid { grid-template-columns: 1fr !important; }
    .cron-panel { max-height: 300px; }
    .right-panels .panel-row { flex-direction: column; }
    .right-panels .panel-row .card { min-width: 100%; }
    .card { padding: 12px; font-size: 13px; }
    h1 { font-size: 18px; }
    h2 { font-size: 14px; }
    .cron-job { padding: 8px 10px; }
    .cron-name { font-size: 12px; }
    .cron-meta { font-size: 11px; }
    .updated { font-size: 10px; }
    .failure-table { font-size: 11px; }
    .failure-table th, .failure-table td { padding: 6px 8px; }
  }

</style>
</head>
<body>
<h1>Robert — Loop Health Dashboard</h1>

<div class="grid">
  <!-- Cron Jobs — left sidebar -->
  <div class="card cron-panel">
    <h2>Cron Jobs</h2>
    <div id="cron-list"><div class="no-data">Loading...</div></div>
  </div>

  <!-- Right column — all other panels -->
  <div class="right-panels">

    <!-- Row: Failure + Progression + Session -->
    <div class="panel-row">
      <div class="card">
        <h2>Failure Patterns (30d)</h2>
        <div id="failure-summary"><div class="no-data">Loading...</div></div>
      </div>
      <div class="card">
        <h2>Progression Signals</h2>
        <div id="progression"><div class="no-data">Loading...</div></div>
      </div>
      <div class="card">
        <h2>Session Metrics</h2>
        <div id="session-metrics"><div class="no-data">Loading...</div></div>
      </div>
    </div>

    <!-- Row: Convergence + Planning Gate -->
    <div class="panel-row">
      <div class="card">
        <h2>Convergence Rate</h2>
        <div id="convergence-rate"><div class="no-data">Loading...</div></div>
      </div>
      <div class="card">
        <h2>Johanna's Plan Gate</h2>
        <div id="planning-gate"><div class="no-data">Loading...</div></div>
      </div>
    </div>

    <!-- Recent Failures -->
    <div class="card">
      <h2>Recent Failure Entries</h2>
      <div id="recent-failures"><div class="no-data">Loading...</div></div>
    </div>

  </div><!-- end right-panels -->
</div>

<div class="updated" id="updated">—</div>

<script>
const REFRESH = ${REFRESH_MS};

async function load() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const r = await fetch('/api/health', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    console.log('[Loop Dashboard] API OK, failures.recent:', (d.failures?.recent || []).length, 'total:', d.failures?.total);
    try { render(d); } catch(e) { console.error('[Loop Dashboard] render error:', e.message, e.stack); document.getElementById('updated').textContent = 'Render error: ' + e.message; }
    document.getElementById('updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn('[Loop Dashboard] API failed:', e.message, '— trying embedded data');
    const embedded = document.getElementById('embedded-data');
    if (embedded) {
      try {
        const d = JSON.parse(embedded.textContent);
        console.log('[Loop Dashboard] Embedded OK, failures.recent:', (d.failures?.recent || []).length, 'total:', d.failures?.total);
        try { render(d); } catch(e) { console.error('[Loop Dashboard] render error:', e.message, e.stack); document.getElementById('updated').textContent = 'Render error: ' + e.message; }
        document.getElementById('updated').textContent = 'Fallback: loaded from embedded data (' + new Date().toLocaleTimeString() + ')';
      } catch (e2) {
        console.error('[Loop Dashboard] Embedded parse failed:', e2.message);
        document.getElementById('updated').textContent = 'Error: ' + (e.message || e2.message);
        document.getElementById('cron-list').innerHTML = '<div class="no-data">API failed: ' + e.message + '</div>';
      }
    } else {
      console.error('[Loop Dashboard] No embedded data found!');
      document.getElementById('updated').textContent = 'Error: no data — ' + e.message;
    }
  }
}


function fmtAge(ms) {
  // If ms looks like a raw Unix timestamp (too large for elapsed ms), convert to elapsed
  if (ms > 1e12) ms = Date.now() - ms;
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function render(d) {
  if (!d) { console.error('[Loop Dashboard] render called with no data!'); return; }
  // Cron jobs
  const cronEl = document.getElementById('cron-list');
  if (!cronEl) { console.error('[Loop Dashboard] cron-list element not found!'); return; }
  if (!d.cronJobs || d.cronJobs.length === 0) {
    cronEl.innerHTML = '<div class="no-data">No cron jobs found (gateway may be unreachable)</div>';
  } else {
    cronEl.innerHTML = '<div class="cron-list">' + d.cronJobs.map(j => {
      const cls = j.lastRunStatus === 'ok' ? 'ok' : j.lastRunStatus === 'error' ? 'error' : 'warn';
      const badge = j.lastRunStatus === 'ok' ? 'badge badge-ok' : j.lastRunStatus === 'error' ? 'badge badge-error' : 'badge badge-warn';
      const badge2 = j.enabled ? '' : '<span class="badge badge-disabled">disabled</span>';
      const fail = j.consecutiveFailures > 0 ? ' ⚠️' + j.consecutiveFailures + ' fails' : '';
      return '<div class="cron-item ' + cls + '">' +
        '<div><div class="cron-name">' + j.name + ' ' + badge2 + '</div>' +
        '<div class="cron-meta">Last: ' + fmtAge(j.lastRun) + ' • Next: ' + fmtAge(j.nextRun) + fail + '</div></div>' +
        '<span class="' + badge + '">' + (j.lastRunStatus || 'unknown') + '</span></div>';
    }).join('') + '</div>';
  }

  // Failure summary
  const f = d.failures || {};
  const fs = f.bySeverity || {};
  document.getElementById('failure-summary').innerHTML =
    '<div class="metric-row">' +
    '<div class="metric"><div class="metric-value">' + (f.total || 0) + '</div><div class="metric-label">Total (30d)</div></div>' +
    '<div class="metric"><div class="metric-value" style="color:#ef4444">' + (fs.high || 0) + '</div><div class="metric-label">High</div></div>' +
    '<div class="metric"><div class="metric-value" style="color:#f59e0b">' + (fs.medium || 0) + '</div><div class="metric-label">Medium</div></div>' +
    '<div class="metric"><div class="metric-value">' + (fs.low || 0) + '</div><div class="metric-label">Low</div></div>' +
    '</div>';

  // Progression signals
  const ps = d.metrics?.progressionSignals || [];
  const psEl = document.getElementById('progression');
  if (ps.length === 0) {
    psEl.innerHTML = '<div class="no-data">No progression signals yet</div>';
  } else {
    psEl.innerHTML = '<div class="cron-list">' + ps.slice(0, 10).map(p => 
      '<div class="cron-item warn"><div><div class="cron-name">#' + p.issue + '</div>' +
      '<div class="cron-meta">' + p.step + ' • ' + p.sessions + ' sessions • ' + p.date + '</div></div>' +
      '<span class="badge badge-warn">4+ sessions</span></div>'
    ).join('') + '</div>';
  }

  // Session metrics
  const secs = d.metrics?.sections || [];
  // Self-correction rate
  const scr = d.metrics?.selfCorrectionRate;
  const scrColor = scr === null ? '#64748b' : scr >= 80 ? '#22c55e' : scr >= 60 ? '#f59e0b' : '#ef4444';

  document.getElementById('session-metrics').innerHTML =
    '<div class="metric-row">' +
    '<div class="metric"><div class="metric-value">' + (metrics?.totalSessions || 0) + '</div><div class="metric-label">Issues tracked</div></div>' +
    '<div class="metric"><div class="metric-value" style="color:' + scrColor + '">' + (scr !== null ? scr + '%' : '—') + '</div><div class="metric-label">Correct 1st try</div></div>' +
    '<div class="metric"><div class="metric-value">' + ((d.metrics?.hardSessions || 0) || 0) + '</div><div class="metric-label">Needed revision (4+)</div></div>' +
    '</div>';

  // Convergence rate
  const convRate = d.metrics?.convergenceRate;
  const convColor = convRate === null ? '#64748b' : convRate >= 70 ? '#22c55e' : convRate >= 40 ? '#f59e0b' : '#ef4444';
  document.getElementById('convergence-rate').innerHTML =
    '<div class="metric-row">' +
    '<div class="metric"><div class="metric-value" style="color:' + convColor + '">' + (convRate !== null ? convRate + '%' : '—') + '</div><div class="metric-label">Convergence (30d)</div></div>' +
    '<div class="metric"><div class="metric-value">' + (d.metrics?.completedIssues || 0) + '</div><div class="metric-label">Completed</div></div>' +
    '<div class="metric"><div class="metric-value">' + (d.metrics?.totalIssues || 0) + '</div><div class="metric-label">Total worked</div></div>' +
    '</div>' +
    '<div style="font-size:11px;color:#475569;margin-top:8px">Definition: % of started issues that reached Done within 7 days</div>';

  // Planning Gate
  const pg = d.planningGate;
  const pgEl = document.getElementById('planning-gate');
  if (!pg || pg.total === 0) {
    pgEl.innerHTML = '<div class="no-data">No data yet</div>';
  } else {
    const pgColor = pg.directPct >= 80 ? '#22c55e' : pg.directPct >= 60 ? '#f59e0b' : '#ef4444';
    pgEl.innerHTML =
      '<div class="metric-row">' +
      '<div class="metric"><div class="metric-value" style="color:' + pgColor + '">' + pg.directPct + '%</div><div class="metric-label">Direct approval</div></div>' +
      '<div class="metric"><div class="metric-value">' + pg.direct + '</div><div class="metric-label">No feedback</div></div>' +
      '<div class="metric"><div class="metric-value" style="color:#f59e0b">' + pg.iterations + '</div><div class="metric-label">Iteration</div></div>' +
      '<div class="metric"><div class="metric-value">' + pg.pending + '</div><div class="metric-label">Pending</div></div>' +
      '</div>' +
      '<div style="font-size:11px;color:#475569;margin-top:6px">Updated: ' + (pg.updated || '—') + '</div>';
  }

  // Recent failures table — pre-rendered server-side, skip in browser render
  // (prevents overwriting server-rendered content with stale data)
  const rfEl = document.getElementById('recent-failures');
  console.log('[Loop Dashboard] render: recent-failures section preserved (server-rendered), rf length:', (f.recent || []).length);
}


load();
setInterval(load, REFRESH);
document.getElementById('updated').innerHTML = '<span class="refresh"><span class="refresh-indicator"></span>Auto-refreshing every ' + (REFRESH/1000) + 's</span>';
</script>
</body>
</html>`;
}

// Builds HTML for the failures table - server-side only, no browser API
function buildFailuresTableHTML(failures) {
  const rf = failures?.recent || [];
  if (rf.length === 0) {
    return '<div class="no-data">No failure entries yet</div>';
  }
  const rows = rf.map(e => {
    const sev = (e.severity || '').toLowerCase();
    const sevColor = sev === 'high' ? '#ef4444' : sev === 'medium' ? '#f59e0b' : '#64748b';
    const typeBadge = e.type === 'NEW' ? '<span class="badge badge-warn">NEW</span>' : '<span class="badge badge-ok">KNOWN</span>';
    const issueNum = (e.issue || '').replace('#', '');
    const issueLink = issueNum && issueNum !== 'N/A'
      ? '<a href="https://github.com/yellow-house-studio/studywise-api/issues/' + issueNum + '" target="_blank" style="color:#60a5fa;text-decoration:none">#' + issueNum + ' ↗</a>'
      : (e.issue || '');
    return '<tr>' +
      '<td>' + (e.date || '') + '</td>' +
      '<td>' + issueLink + '</td>' +
      '<td>' + (e.pattern || '') + '</td>' +
      '<td>' + (e.gate || '') + '</td>' +
      '<td>' + typeBadge + '</td>' +
      '<td style="color:' + sevColor + '">' + (e.severity || '') + '</td>' +
      '<td style="color:#64748b">' + (e.notes || '') + '</td>' +
      '</tr>';
  }).join('');
  return '<table class="table"><thead><tr>' +
    '<th>Date</th><th>Issue</th><th>Pattern</th><th>Gate</th><th>Type</th><th>Severity</th><th>Notes</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// Server-side: formats a millisecond timestamp as "X ago"
function fmtAgeMs(ms) {
  if (!ms) return '—';
  const ageS = Math.floor((Date.now() - ms) / 1000);
  if (ageS < 0) return 'in the future';
  if (ageS < 60) return ageS + 's ago';
  const m = Math.floor(ageS / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Kept for browser compatibility (accepts relative ms)
function fmtAgeServer(unixSeconds) {
  if (!unixSeconds) return '—';
  const s = Math.floor(unixSeconds);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/health') {
    await handleApi(res);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'robert-loop-dashboard' }));
  } else {
    // Fetch data and embed in HTML for initial render
    const [cronJobs, metrics, failures, convergence, planningGate] = await Promise.all([
      getGatewayCronJobs().catch(() => []),
      Promise.resolve(parseMetrics()),
      Promise.resolve(parseFailureLog()),
      getConvergenceRate().catch(() => null),
      Promise.resolve(parsePlanningGate())
    ]);
    const data = {
      timestamp: new Date().toISOString(),
      cronJobs,
      metrics: { ...metrics, ...convergence },
      failures,
      planningGate,
      gateway: { port: GATEWAY_PORT, connected: !cronJobs.error }
    };
    const embeddedData = '<script id="embedded-data" type="application/json">' + JSON.stringify(data).replace(/</g, '<').replace(/>/g, '>') + '</script>';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    let html = render().replace('</body>', embeddedData + '</body>');
    // Pre-render all sections server-side so page loads instantly without JS
    // Cron jobs
    if (!cronJobs.error && cronJobs.length > 0) {
      const cronHTML = '<div class="cron-list">' + cronJobs.map(j => {
        const cls = j.lastRunStatus === 'ok' ? 'ok' : j.lastRunStatus === 'error' ? 'error' : 'warn';
        const badge = j.lastRunStatus === 'ok' ? 'badge badge-ok' : j.lastRunStatus === 'error' ? 'badge badge-error' : 'badge badge-warn';
        const badge2 = j.enabled ? '' : '<span class="badge badge-disabled">disabled</span>';
        const fail = j.consecutiveFailures > 0 ? ' ⚠️' + j.consecutiveFailures + ' fails' : '';
        // j.lastRun/j.nextRun are in milliseconds (lastRunAtMs/nextRunAtMs from OpenClaw)
        // fmtAge handles milliseconds directly
        const lastAge = j.lastRun ? fmtAgeMs(j.lastRun) : '—';
        const nextAge = j.nextRun ? fmtAgeMs(j.nextRun) : '—';
        return '<div class="cron-item ' + cls + '"><div><div class="cron-name">' + j.name + ' ' + badge2 + '</div><div class="cron-meta">Last: ' + lastAge + ' • Next: ' + nextAge + fail + '</div></div><span class="' + badge + '">' + (j.lastRunStatus || 'unknown') + '</span></div>';
      }).join('') + '</div>';
      html = html.replace('<div id="cron-list"><div class="no-data">Loading...</div></div>', '<div id="cron-list">' + cronHTML + '</div>');
    }
    // Failure summary
    const fs = failures?.bySeverity || {};
    const ft = failures?.total || 0;
    const failureSummaryHTML = '<div class="metric-row"><div class="metric"><div class="metric-value">' + ft + '</div><div class="metric-label">Total (30d)</div></div><div class="metric"><div class="metric-value" style="color:#ef4444">' + (fs.high || 0) + '</div><div class="metric-label">High</div></div><div class="metric"><div class="metric-value" style="color:#f59e0b">' + (fs.medium || 0) + '</div><div class="metric-label">Medium</div></div><div class="metric"><div class="metric-value">' + (fs.low || 0) + '</div><div class="metric-label">Low</div></div></div>';
    html = html.replace('<div id="failure-summary"><div class="no-data">Loading...</div></div>', '<div id="failure-summary">' + failureSummaryHTML + '</div>');
    // Progression signals
    const ps = metrics?.progressionSignals || [];
    if (ps.length > 0) {
      const psHTML = '<div class="cron-list">' + ps.slice(0, 10).map(p => '<div class="cron-item warn"><div><div class="cron-name">#' + p.issue + '</div><div class="cron-meta">' + p.step + ' • ' + p.sessions + ' sessions • ' + p.date + '</div></div><span class="badge badge-warn">4+ sessions</span></div>').join('') + '</div>';
      html = html.replace('<div id="progression"><div class="no-data">Loading...</div></div>', '<div id="progression">' + psHTML + '</div>');
    } else {
      html = html.replace('<div id="progression"><div class="no-data">Loading...</div></div>', '<div id="progression"><div class="no-data">No progression signals yet</div></div>');
    }
    // Session metrics
    const secs = metrics?.sections || [];
    const scr = metrics?.selfCorrectionRate;
    const scrColor = scr === null ? '#64748b' : scr >= 80 ? '#22c55e' : scr >= 60 ? '#f59e0b' : '#ef4444';
    const sessionMetricsHTML = '<div class="metric-row"><div class="metric"><div class="metric-value">' + (metrics?.totalSessions || 0) + '</div><div class="metric-label">Issues tracked</div></div><div class="metric"><div class="metric-value" style="color:' + scrColor + '">' + (scr !== null ? scr + '%' : '—') + '</div><div class="metric-label">Correct 1st try</div></div><div class="metric"><div class="metric-value">' + (metrics?.hardSessions || 0) + '</div><div class="metric-label">Needed revision (4+)</div></div></div>';
    html = html.replace('<div id="session-metrics"><div class="no-data">Loading...</div></div>', '<div id="session-metrics">' + sessionMetricsHTML + '</div>');
    // Convergence rate
    const convRate = metrics?.convergenceRate;
    const convColor = convRate === null ? '#64748b' : convRate >= 70 ? '#22c55e' : convRate >= 40 ? '#f59e0b' : '#ef4444';
    const convergenceHTML = '<div class="metric-row"><div class="metric"><div class="metric-value" style="color:' + convColor + '">' + (convRate !== null ? convRate + '%' : '—') + '</div><div class="metric-label">Convergence (30d)</div></div><div class="metric"><div class="metric-value">' + (metrics?.completedIssues || 0) + '</div><div class="metric-label">Completed</div></div><div class="metric"><div class="metric-value">' + (metrics?.totalIssues || 0) + '</div><div class="metric-label">Total worked</div></div></div><div style="font-size:11px;color:#475569;margin-top:8px">Definition: % of started issues that reached Done within 7 days</div>';
    html = html.replace('<div id="convergence-rate"><div class="no-data">Loading...</div></div>', '<div id="convergence-rate">' + convergenceHTML + '</div>');
    // Planning Gate
    const pg = planningGate;
    if (pg && pg.total > 0) {
      const pgColor = pg.directPct >= 80 ? '#22c55e' : pg.directPct >= 60 ? '#f59e0b' : '#ef4444';
      const pgHTML = '<div class="metric-row"><div class="metric"><div class="metric-value" style="color:' + pgColor + '">' + pg.directPct + '%</div><div class="metric-label">Direct approval</div></div><div class="metric"><div class="metric-value">' + pg.direct + '</div><div class="metric-label">No feedback</div></div><div class="metric"><div class="metric-value" style="color:#f59e0b">' + pg.iterations + '</div><div class="metric-label">Iteration</div></div><div class="metric"><div class="metric-value">' + pg.pending + '</div><div class="metric-label">Pending</div></div></div><div style="font-size:11px;color:#475569;margin-top:6px">Updated: ' + (pg.updated || '—') + '</div>';
      html = html.replace('<div id="planning-gate"><div class="no-data">Loading...</div></div>', '<div id="planning-gate">' + pgHTML + '</div>');
    }
    // Recent failures table
    html = html.replace('<div id="recent-failures"><div class="no-data">Loading...</div></div>', '<div id="recent-failures">' + buildFailuresTableHTML(failures) + '</div>');
    res.end(html);
  }
});

server.listen(PORT, () => {
  console.log(`Robert Loop Health Dashboard running on http://localhost:${PORT}`);
  console.log(`Reading workspace: ${WORKSPACE}`);
});
