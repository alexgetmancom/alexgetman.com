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
    .studio-locale { display:flex; justify-content:flex-end; gap:6px; margin:0 0 6px; }
    .studio-locale a { border:1px solid #30363d; border-radius:14px; padding:3px 9px; font-size:13px; text-decoration:none; }
    .studio-locale a.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
    .studio-analytics { white-space:normal; line-height:1.6; }
    .attention-list, .notification-list { list-style:none; margin:0; padding:0; }
    .attention-list li { padding:6px 0; border-bottom:1px solid #21262d; }
    .notification-list li { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #21262d; }
    .notification-list li:last-child { border-bottom:0; }
    .notification-list span { flex:1; }
    .notification-list time { color:#8b949e; font-size:12px; white-space:nowrap; }
    .notification--warn span, .notification--error span { color:#ff7b72; }

    /* Overview: quiet, information-first surface. Operational panels retain the shared controls above. */
    body { padding:24px; background:#050607; color:#aeb6c2; }
    main { max-width:1440px; }
    .dashboard-tabs { display:flex; align-items:center; gap:22px; margin:0 0 28px; border-bottom:1px solid #20252d; }
    .dashboard-tabs a { padding:0 0 11px; border:0; border-radius:0; background:transparent; color:#697382; font-size:16px; font-weight:600; }
    .dashboard-tabs a:hover { color:#dce7f5; border:0; }
    .dashboard-tabs a.active { background:transparent; color:#f5f8fc; border:0; box-shadow:inset 0 -2px #4c98ff; }
    .pipeline-overview { padding:0; background:transparent; border:0; border-radius:0; overflow:visible; }
    .dashboard-nav__controls { display:flex; align-items:center; gap:18px; margin-left:auto; padding-bottom:10px; }
    .period-controls { display:flex; padding:3px; border:1px solid #252b34; border-radius:8px; background:rgba(255,255,255,.025); }
    .dashboard-tabs .period-btn { padding:6px 11px; border-radius:5px; color:#8d98a7; text-decoration:none; font-size:14px; font-weight:650; }
    .period-btn.active { background:rgba(76,152,255,.16); color:#a9d0ff; }
    .period-range { display:flex; gap:11px; align-items:center; color:#8f9aaa; font-size:15px; }
    .period-range strong { color:#dce4ee; font-weight:600; min-width:138px; text-align:center; }
    .period-nav { color:#8e99a9; text-decoration:none; font-size:23px; line-height:20px; } .period-nav.muted { opacity:.28; }
    .kpi-row { display:grid; grid-template-columns:repeat(4,1fr); margin:0 0 28px; border-top:1px solid #1c222a; border-bottom:1px solid #1c222a; }
    .kpi-row > div { padding:12px 26px 18px; min-width:0; } .kpi-row > div + div { border-left:1px solid #1c222a; }
    .kpi-row span,.section-kicker { display:block; color:#7f8b9b; font-size:14px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    .kpi-row strong { display:block; color:#edf3fa; font-size:54px; line-height:1.05; font-weight:500; letter-spacing:-.055em; }
    .kpi-row .kpi > span { margin-top:7px; color:#d0d8e2; font-size:17px; font-weight:500; letter-spacing:0; text-transform:none; }
    .kpi-delta { display:block; margin-top:8px; color:#3b8dff; font-size:15px; font-style:normal; font-weight:650; } .kpi-delta--down { color:#ff607e; } .kpi-delta i { margin-left:7px; color:#8b96a4; font-style:normal; font-weight:400; }
    .insights-row { display:grid; grid-template-columns:minmax(210px,.31fr) minmax(0,.69fr); gap:42px; padding-bottom:31px; border-bottom:1px solid #1c222a; }
    .audience-panel,.chart-panel { padding:0; background:transparent; border:0; }
    .audience-list { margin-top:14px; } .audience-line { display:flex; align-items:baseline; justify-content:space-between; padding:12px 0; border-bottom:1px solid #151a20; font-size:17px; }
    .audience-line__label { display:inline-flex; align-items:center; gap:12px; } .audience-line__label i { display:inline-flex; width:24px; height:24px; align-items:center; justify-content:center; color:#e5eaf0; font-style:normal; } .audience-line__label svg { width:22px; height:22px; }
    .audience-line span { color:#c3cbd5; } .audience-line strong { color:#e4eaf2; font-size:18px; font-weight:600; }
    .metric-chart { margin-top:8px; padding:0; background:transparent; border:0; border-radius:0; }
    .metric-chart svg { height:188px; } .metric-chart text { font-size:13px; } .metric-chart__legend { margin:11px 0 0; font-size:15px; color:#b3bdca; }
    .metric-chart__hint { display:none; } .chart-grid { stroke:#1e252d; } .chart-point { stroke:#050607; }
    .publication-columns { display:grid; grid-template-columns:minmax(340px,.3fr) minmax(0,.7fr); gap:34px; padding-top:26px; }
    .best-posts,.recent-posts { min-width:0; padding:0; border:0; border-radius:0; background:transparent; } .recent-posts { padding-left:34px; border-left:1px solid #1c222a; }
    .best-post { display:grid; grid-template-columns:39px 32px minmax(0,1fr) 92px; gap:13px; align-items:start; padding:18px 0; border-bottom:1px solid #171c22; }
    .post-rank { color:#4c98ff; font-size:31px; line-height:1; font-weight:500; padding-top:1px; } .best-post__media { display:flex; align-items:center; justify-content:center; width:26px; height:26px; color:#b3bdca; border:1px solid #485260; border-radius:4px; font-size:17px; }
    .best-post__title { color:#d7dee8; font-size:16px; line-height:1.4; } .best-post__stats { text-align:right; white-space:nowrap; } .best-post__stats strong { display:block; color:#edf3fa; font-size:18px; font-weight:600; } .best-post__stats small { display:block; color:#8792a0; font-size:12px; } .best-post__stats em { display:block; margin-top:8px; color:#ff4e75; font-size:14px; font-style:normal; }
    .empty-state { color:#697483; font-size:14px; }
    .recent-posts__header,.post-detail__summary { display:grid; grid-template-columns:minmax(0,1fr) 170px repeat(3,120px); align-items:center; gap:14px; }
    .recent-posts__header { padding:0 0 14px; border-bottom:1px solid #1c222a; color:#9aa6b5; font-size:14px; } .recent-posts__header > span { text-align:right; }
    .post-detail { margin:0; border:0; border-bottom:1px solid #171c22; border-radius:0; background:transparent; }
    .post-detail > summary { padding:13px 0; color:inherit; font-size:inherit; font-weight:400; list-style:none; cursor:pointer; } .post-detail > summary::-webkit-details-marker { display:none; }
    .post-detail__summary { font-size:16px; }
    .post-detail__headline { display:grid; grid-template-columns:24px minmax(0,1fr); align-items:center; gap:14px; min-width:0; }
    .post-detail__chevron { color:#d6dee8; font-size:22px; line-height:12px; transform:rotate(0deg); transition:transform .15s; } .post-detail[open] .post-detail__chevron { transform:rotate(90deg); }
    .post-detail__title { color:#e0e6ee; font-size:17px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .post-detail__media { color:#9da8b6; text-align:right; }
    .post-detail__summary > span:nth-last-child(-n+4) { color:#d7dee8; text-align:right; } .post-detail__body { padding:0 0 22px; }
    .post-platforms { padding:12px 0 17px 38px; border-bottom:1px solid #171c22; } .post-platforms__grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(214px,1fr)); gap:8px; margin-top:10px; }
    .post-platform { display:flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; padding:8px 10px; border:1px solid #202731; border-radius:6px; background:rgba(255,255,255,.018); color:#d8e0e9; font-size:13px; text-decoration:none; } a.post-platform:hover { border-color:#4c98ff; }
    .post-platform__name { display:inline-flex; align-items:center; gap:7px; min-width:0; font-weight:600; } .post-platform__name svg { width:16px; height:16px; flex:0 0 auto; } .post-platform__name > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .post-platform__metrics { color:#8f9aaa; font-size:12px; white-space:nowrap; } .post-platform__metrics b { color:#dce4ed; font-weight:600; }
    .post-detail__content { display:grid; grid-template-columns:minmax(0,1fr) 132px; gap:22px; padding:18px 0 0 38px; }
    .post-detail__body p { margin:5px 0 16px; color:#b1bbc8; font-size:16px; line-height:1.5; white-space:pre-wrap; } .post-detail__label { color:#748194; font-size:13px; font-weight:700; letter-spacing:.1em; }
    .post-preview { display:flex; width:132px; height:108px; align-items:center; justify-content:center; overflow:hidden; background:#101419; color:#8d99a9; text-decoration:none; font-size:13px; } .post-preview img { width:100%; height:100%; object-fit:cover; }
    .post-preview--empty { border:1px solid #20262e; }

    @media (max-width: 760px) {
      body { padding:10px; }
      main { max-width:none; }
      .metric-dashboard { grid-template-columns:1fr; }
      .metric-toggle--vertical { flex-direction:row; justify-content:flex-start; }
      .pagination-bar { align-items:stretch; flex-wrap:wrap; justify-content:center; }
      .pag-current { flex:1 1 100%; text-align:center; }
      .dashboard-tabs { gap:14px; } .dashboard-nav__controls { width:100%; margin-left:0; justify-content:space-between; padding-top:2px; } .kpi-row { grid-template-columns:repeat(2,1fr); }
      .kpi-row > div:nth-child(3) { border-left:0; border-top:1px solid #1c222a; } .kpi-row > div:nth-child(4) { border-top:1px solid #1c222a; }
      .insights-row,.publication-columns { grid-template-columns:1fr; gap:28px; } .recent-posts { padding-left:0; border-left:0; } .recent-posts__header { grid-template-columns:minmax(0,1fr) auto; } .recent-posts__header > span:nth-last-child(-n+2) { display:none; } .post-detail__summary { grid-template-columns:minmax(0,1fr) auto; } .post-detail__summary > span:nth-last-child(-n+2) { display:none; } .post-detail__media { display:none; } .post-platforms,.post-detail__content { padding-left:0; } .post-platforms__grid { grid-template-columns:1fr; } .post-detail__content { grid-template-columns:1fr; } .post-preview { display:none; }
    }
  </style>
</head>
<body>
<main>
  ${body}
</main>
<script>
  function setMetric(m) {
    const tbl = document.getElementById('pipeline-table');
    if (!tbl) return;
    tbl.className = tbl.className.replace(/show-m\\w/g, '') + ' show-' + m;
    document.querySelectorAll('.mt-btn').forEach(b => b.classList.toggle('mt-active', b.dataset.m === m));
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
  let dashboardFingerprint = '';
  setInterval(async () => {
    try {
      const response = await fetch('/api/command-center', { credentials: 'same-origin' });
      if (!response.ok) return;
      const payload = await response.json();
      const fingerprint = JSON.stringify([payload.pipeline?.updated_at, payload.jobs?.[0]?.updatedAt, payload.events?.[0]?.createdAt, payload.videoRevision?.value]);
      const editingForm = document.activeElement instanceof Element && document.activeElement.closest('form');
      if (editingForm) return;
      if (dashboardFingerprint && fingerprint !== dashboardFingerprint) window.location.reload();
      dashboardFingerprint = fingerprint;
    } catch { /* the current screen remains usable while the worker restarts */ }
  }, 15000);
</script>
</body>
</html>`;
}
