export function renderDashboardShell(body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Command Center</title>
  <style>
    body { margin:0; padding:12px; background:#0d1117; color:#c9d1d9; font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1680px; margin:0 auto; }
    h1,h2 { color:#fff; }
    .dashboard-heading { margin-bottom:12px; }
    .dashboard-heading h1 { margin-bottom:4px; }
    .dashboard-tabs { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 6px; }
    .dashboard-tabs a { border:1px solid #30363d; border-radius:14px; padding:4px 9px; font-size:14px; text-decoration:none; color:#c9d1d9; background:#161b22; }
    .dashboard-tabs a:hover { border-color:#58a6ff; color:#58a6ff; }
    .dashboard-tabs a.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
    .overview { padding:0; border:0; background:transparent; overflow:visible; }
    .audience-strip { margin:0 0 6px; padding:6px; border:1px solid #30363d; border-radius:8px; background:#161b22; }
    .audience-cards { display:flex; gap:6px; overflow-x:auto; padding-bottom:2px; }
    .audience-card { flex:0 0 auto; min-width:86px; padding:5px 8px; border:1px solid #30363d; border-radius:6px; background:#0d1117; }
    .audience-card strong,.audience-card b { display:block; }
    .audience-card strong { color:#8b949e; font-size:12px; }
    .audience-card b { color:#58a6ff; font-size:16px; margin-top:2px; }
    .audience-strip details { margin:5px 0 0; }
    .audience-strip details > summary { font-size:13px; padding:5px 7px; }
    .command-login { max-width:560px; margin:12vh auto; padding:24px; }
    .login-error { color:#ff7b72; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:12px 0 18px; }
    .stat, section { border:1px solid #30363d; background:#161b22; border-radius:8px; }
    .stat { padding:14px; } .stat span { display:block; color:#58a6ff; font-size:24px; font-weight:700; margin-top:6px; }
    section { margin-top:0; padding:10px; overflow-x:auto; }
    details { margin:6px 0; border:1px solid #30363d; border-radius:8px; background:#161b22; }
    details > summary { cursor:pointer; padding:8px 10px; color:#fff; font-size:15px; font-weight:700; }
    details > section { border:0; border-radius:0; border-top:1px solid #30363d; }
    .pipeline-target-details { margin:6px 0 0; }
    .pipeline-target-details > summary { padding:5px 8px; font-size:13px; }
    .pipeline-target-details:not([open]) + .table-wrap .secondary-target { display:none; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; min-width:980px; border-collapse:collapse; }
    th,td { padding:6px 10px; border-bottom:1px solid #30363d; text-align:left; vertical-align:top; }
    th { color:#8b949e; white-space:nowrap; }
    a { color:#58a6ff; } .wide { max-width:520px; overflow-wrap:anywhere; }
    .post-text { min-width:160px; max-width:280px; overflow-wrap:anywhere; }
    .nowrap { white-space:nowrap; } .note { color:#8b949e; }
    .date-col { width:60px; }
    .text-center { text-align:center; }

    th svg { color:#8b949e; transition:color 0.2s; }
    th:hover svg { color:#fff; }
    form { display:flex; flex-wrap:wrap; gap:8px; }
    input,select,textarea,button { background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:8px; }
    textarea { min-width:min(720px,100%); min-height:70px; }
    
    .day-header td { background: #21262d; color: #fff; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #30363d; }
    .week-total td { background: #1a3a5c; color: #7dd3fc; font-weight: 700; padding: 10px 12px; border-top: 2px solid #3b82f6; border-bottom: 2px solid #3b82f6; }
    .day-separator td { padding: 4px 12px 2px; background: transparent; border-top: 1px solid #30363d; border-bottom: 0; }
    .day-label { font-size: 11px; font-weight: 700; color: #8b949e; text-transform: uppercase; letter-spacing: 0.06em; }
    
    .mv,.ml,.mr,.mp { display:none; }
    #pipeline-table.show-mv .mv { display:inline; }
    #pipeline-table.show-ml .ml { display:inline; }
    #pipeline-table.show-mr .mr { display:inline; }
    #pipeline-table.show-mp .mp { display:inline; }
    
    .metric-dashboard { display:grid; grid-template-columns:112px minmax(0,1fr); gap:8px; align-items:stretch; margin:0 0 8px; }
    .metric-toggle { display:flex; gap:6px; margin:0; }
    .metric-toggle--vertical { flex-direction:column; justify-content:center; }
    .mt-btn { background:#161b22; color:#8b949e; border:1px solid #30363d; border-radius:18px; padding:5px 10px; font-size:13px; cursor:pointer; transition:all 0.15s; text-align:left; }
    .mt-btn:hover { background:#21262d; color:#c9d1d9; }
    .mt-btn.mt-active { background:#1f6feb; color:#fff; border-color:#1f6feb; font-weight:600; }
    .day-stat td { border-top: 1px solid #30363d; border-bottom: 2px double #30363d; background: #161b22; color: #c9d1d9; }
    .day-stat-label { text-align: right; color: #8b949e; font-weight: normal; }
    .font-bold { font-weight: bold; }
    .pagination-bar { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 8px; padding: 5px 8px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .pag-btn { color: #58a6ff; border: 1px solid #30363d; padding: 4px 9px; border-radius: 6px; text-decoration: none; font-size: 12px; background: #0d1117; transition: background 0.2s, border-color 0.2s; }
    .pag-btn:hover:not(.disabled) { background: #21262d; border-color: #8b949e; }
    .pag-btn.disabled { color: #8b949e; border-color: #21262d; background: #0d1117; cursor: not-allowed; }
    .pag-current { font-weight: 700; color: #fff; font-size: 14px; }
    .metric-chart { position:relative; margin:0; padding:7px 10px 4px; background:#0d1117; border:1px solid #30363d; border-radius:8px; }
    .metric-chart svg { width:100%; height:166px; display:block; }
    .metric-chart text { fill:#8b949e; font-size:11px; }
    .chart-grid { stroke:#30363d; stroke-width:1; opacity:.75; }
    .chart-line { vector-effect: non-scaling-stroke; }
    .metric-chart__legend { display:flex; flex-wrap:wrap; gap:11px; margin:0 0 -1px; color:#c9d1d9; font-size:12px; }
    .metric-chart__legend span { display:inline-flex; align-items:center; gap:5px; }
    .metric-chart__legend i { display:inline-block; width:9px; height:9px; border-radius:50%; }
    .metric-chart__hint { color:#8b949e; font-size:11px; margin:0 0 2px; }
    .chart-point { vector-effect: non-scaling-stroke; stroke:#0d1117; stroke-width:1.4; }
    .chart-hit { fill:transparent; cursor:crosshair; }
    .chart-tooltip { position:fixed; z-index:50; pointer-events:none; max-width:280px; padding:7px 9px; background:#161b22; border:1px solid #58a6ff; border-radius:6px; color:#f0f6fc; font-size:12px; box-shadow:0 8px 24px rgba(0,0,0,.35); white-space:nowrap; }
    
    .metric-link { text-decoration: none; }
    .video-dashboard { padding:10px; }
    .video-stats { margin:0 0 10px; }
    .video-dashboard small { color:#8b949e; }
    .video-chart { margin:0 0 10px; }
    .video-chart-note { margin:0 0 10px; }
    .video-chart-labels { display:flex; justify-content:space-between; color:#8b949e; font-size:11px; }
    .danger { color:#ff7b72; font-weight:700; }
    
    .status-strip { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 8px; }
    .pill { display:inline-flex; align-items:center; gap:5px; font-size:13px; color:#c9d1d9; text-decoration:none; border:1px solid #30363d; border-radius:14px; padding:4px 10px; background:#161b22; }
    a.pill:hover { border-color:#58a6ff; }
    .pill-danger { color:#ff7b72; border-color:#6e2b26; }
    .pill-ok { color:#3fb950; border-color:#1f4428; }
    .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin:0 0 8px; }
    .kpi { border:1px solid #30363d; border-radius:8px; background:#161b22; padding:10px 12px; }
    .kpi small { display:block; color:#8b949e; font-size:12px; }
    .kpi-value { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; margin:2px 0 4px; }
    .kpi-value b { color:#fff; font-size:22px; }
    .kpi svg { width:100%; height:26px; display:block; }
    .chip { font-size:12px; font-weight:600; border-radius:10px; padding:1px 7px; white-space:nowrap; }
    .chip-up { color:#3fb950; background:rgba(63,185,80,.12); }
    .chip-down { color:#f85149; background:rgba(248,81,73,.12); }
    .chip-flat { color:#8b949e; background:#21262d; }
    .delta-up { color:#3fb950; } .delta-down { color:#f85149; }
    .dim { color:#57606a; }
    .sigma-bar { display:none; height:4px; min-width:56px; background:#21262d; border-radius:2px; margin-top:3px; }
    .sigma-bar i { display:block; height:4px; border-radius:2px; }
    .sigma-bar.mv i { background:#3987e5; }
    .sigma-bar.ml i { background:#199e70; }
    .sigma-bar.mr i { background:#c98500; }
    .sigma-bar.mp i { background:#9085e9; }
    #pipeline-table.show-mv .sigma-bar.mv, #pipeline-table.show-ml .sigma-bar.ml, #pipeline-table.show-mr .sigma-bar.mr, #pipeline-table.show-mp .sigma-bar.mp { display:block; }
    .sigma-bar-static { display:block; }
    .best-post td { background:rgba(201,133,0,.07); }
    .best-badge { color:#c98500; }
    .er-col { color:#8b949e; white-space:nowrap; }
    .cm { display:none; }
    #weekly-chart.show-mv .cm-mv, #weekly-chart.show-ml .cm-ml, #weekly-chart.show-mr .cm-mr { display:inline; }
    #pipeline-table thead, #video-table thead { position:sticky; top:0; z-index:3; }
    #pipeline-table thead th, #video-table thead th { background:#0d1117; }
    .heatmap-table { width:auto; min-width:0; border-collapse:separate; border-spacing:3px; }
    .heatmap-table th, .heatmap-table td { border:0; padding:6px 12px; border-radius:4px; text-align:center; font-size:12px; }
    .heatmap-table th { color:#8b949e; font-weight:400; }
    .heatmap-note { color:#8b949e; font-size:12px; }
    @media (max-width: 760px) {
      body { padding:10px; }
      main { max-width:none; }
      .metric-dashboard { grid-template-columns:1fr; }
      .metric-toggle--vertical { flex-direction:row; justify-content:flex-start; }
      .pagination-bar { align-items:stretch; flex-wrap:wrap; justify-content:center; }
      .pag-current { flex:1 1 100%; text-align:center; }
    }
  </style>
</head>
<body>
<main>
  ${body}
</main>
<script>
  function setMetric(m) {
    for (const id of ['pipeline-table', 'weekly-chart']) {
      const el = document.getElementById(id);
      if (el) el.className = el.className.replace(/show-m\\w/g, '').trim() + ' show-' + m;
    }
    document.querySelectorAll('.mt-btn').forEach(b => b.classList.toggle('mt-active', b.dataset.m === m));
    try { sessionStorage.setItem('cc-metric', m); } catch {}
  }
  document.getElementById('metric-toggle')?.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.mt-btn') : null;
    const metric = button?.dataset?.m;
    if (metric) setMetric(metric);
  });
  const chartTooltip = document.getElementById('chart-tooltip');
  document.querySelectorAll('.chart-hit').forEach((point) => {
    point.addEventListener('mouseenter', () => {
      if (!chartTooltip) return;
      chartTooltip.textContent = point.dataset.tooltip || '';
      chartTooltip.hidden = false;
    });
    point.addEventListener('mousemove', (event) => {
      if (!chartTooltip) return;
      chartTooltip.style.left = \`\${event.clientX + 12}px\`;
      chartTooltip.style.top = \`\${event.clientY + 12}px\`;
    });
    point.addEventListener('mouseleave', () => {
      if (chartTooltip) chartTooltip.hidden = true;
    });
  });
  function openHashDetails() {
    const id = location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (el && el.tagName === 'DETAILS') el.open = true;
  }
  window.addEventListener('hashchange', openHashDetails);
  openHashDetails();
  try {
    const savedMetric = sessionStorage.getItem('cc-metric');
    if (savedMetric && document.querySelector('.mt-btn[data-m="' + savedMetric + '"]')) setMetric(savedMetric);
    const openDetails = JSON.parse(sessionStorage.getItem('cc-details') || 'null');
    if (Array.isArray(openDetails)) document.querySelectorAll('details').forEach((d, i) => { d.open = openDetails.includes(i); });
    const scrollY = Number(sessionStorage.getItem('cc-scroll') || '');
    if (scrollY) window.scrollTo(0, scrollY);
    sessionStorage.removeItem('cc-details');
    sessionStorage.removeItem('cc-scroll');
  } catch {}
  window.addEventListener('beforeunload', () => {
    try {
      sessionStorage.setItem('cc-scroll', String(window.scrollY));
      sessionStorage.setItem('cc-details', JSON.stringify(Array.from(document.querySelectorAll('details')).flatMap((d, i) => d.open ? [i] : [])));
    } catch {}
  });
  let dashboardFingerprint = '';
  setInterval(async () => {
    try {
      const response = await fetch('/api/command-center', { credentials: 'same-origin' });
      if (!response.ok) return;
      const payload = await response.json();
      const fingerprint = JSON.stringify([payload.pipeline?.updated_at, payload.jobs?.[0]?.updatedAt, payload.events?.[0]?.createdAt, payload.videoRevision?.value]);
      if (dashboardFingerprint && fingerprint !== dashboardFingerprint) window.location.reload();
      dashboardFingerprint = fingerprint;
    } catch { /* the current screen remains usable while the worker restarts */ }
  }, 15000);
</script>
</body>
</html>`;
}
