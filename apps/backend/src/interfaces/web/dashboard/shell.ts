import { DASHBOARD_THEME_BOOT_SCRIPT, DASHBOARD_THEME_CSS, DASHBOARD_THEME_TOGGLE_SCRIPT } from "./theme.js";

export function renderDashboardShell(body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Command Center</title>
  <script>${DASHBOARD_THEME_BOOT_SCRIPT}</script>
  <style>
    ${DASHBOARD_THEME_CSS}

    body { margin:0; padding:24px; background:var(--bg-color); color:var(--text-main); font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1440px; margin:0 auto; }
    h1,h2 { color:var(--text-header); }
    .theme-toggle { width:30px; height:30px; padding:0; border:1px solid var(--border); border-radius:50%; background:var(--surface); color:var(--text-secondary); font-size:14px; line-height:1; cursor:pointer; }
    .theme-toggle:hover { border-color:var(--border-hover); color:var(--text-header); }
    .dashboard-heading { margin-bottom:12px; }
    .dashboard-heading h1 { margin-bottom:4px; }
    .dashboard-tabs { display:flex; align-items:center; flex-wrap:wrap; gap:22px; margin:0 0 16px; border-bottom:1px solid var(--border-soft); }
    .dashboard-tabs a { padding:0 0 11px; border:0; border-radius:0; background:transparent; color:var(--text-muted); font-size:16px; font-weight:600; text-decoration:none; }
    .dashboard-tabs a:hover { color:var(--text-main); }
    .dashboard-tabs a.active { color:var(--text-header); box-shadow:inset 0 -2px var(--accent); }
    .overview { padding:0; border:0; background:transparent; overflow:visible; }
    .audience-strip { margin:0 0 6px; padding:6px; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
    .audience-cards { display:flex; gap:6px; overflow-x:auto; padding-bottom:2px; }
    .audience-card { flex:0 0 auto; min-width:86px; padding:5px 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface-sunken); }
    .audience-card strong,.audience-card b { display:block; }
    .audience-card strong { color:var(--text-muted); font-size:12px; }
    .audience-card b { color:var(--accent); font-size:16px; margin-top:2px; }
    .audience-strip details { margin:5px 0 0; }
    .audience-strip details > summary { font-size:13px; padding:5px 7px; }
    .command-login { max-width:560px; margin:12vh auto; padding:24px; }
    .login-error { color:var(--danger); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:12px 0 18px; }
    .stat, section { border:1px solid var(--border); background:var(--surface); border-radius:8px; }
    .stat { padding:14px; } .stat span { display:block; color:var(--accent); font-size:24px; font-weight:700; margin-top:6px; }
    section { margin-top:0; padding:10px; overflow-x:auto; }
    details { margin:6px 0; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
    details > summary { cursor:pointer; padding:8px 10px; color:var(--text-header); font-size:15px; font-weight:700; }
    details > section { border:0; border-radius:0; border-top:1px solid var(--border); }
    .pipeline-target-details { margin:6px 0 0; }
    .pipeline-target-details > summary { padding:5px 8px; font-size:13px; }
    .pipeline-target-details:not([open]) + .table-wrap .secondary-target { display:none; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; min-width:980px; border-collapse:collapse; }
    th,td { padding:6px 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
    th { color:var(--text-muted); white-space:nowrap; }
    a { color:var(--accent); } .wide { max-width:520px; overflow-wrap:anywhere; }
    .post-text { min-width:160px; max-width:280px; overflow-wrap:anywhere; }
    .nowrap { white-space:nowrap; } .note { color:var(--text-muted); }
    .date-col { width:60px; }
    .text-center { text-align:center; }

    th svg { color:var(--text-muted); transition:color 0.2s; }
    th:hover svg { color:var(--text-header); }
    form { display:flex; flex-wrap:wrap; gap:8px; }
    input,select,textarea,button { background:var(--surface-sunken); color:var(--text-main); border:1px solid var(--border); border-radius:6px; padding:8px; }
    textarea { min-width:min(720px,100%); min-height:70px; }
    
    .day-header td { background: var(--surface-raised); color: var(--text-header); font-weight: 600; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .week-total td { background: var(--total-bg); color: var(--total-text); font-weight: 700; padding: 10px 12px; border-top: 2px solid var(--total-border); border-bottom: 2px solid var(--total-border); }
    .day-separator td { padding: 4px 12px 2px; background: transparent; border-top: 1px solid var(--border); border-bottom: 0; }
    .day-label { font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    
    .mv,.ml,.mr,.mp { display:none; }
    #pipeline-table.show-mv .mv { display:inline; }
    #pipeline-table.show-ml .ml { display:inline; }
    #pipeline-table.show-mr .mr { display:inline; }
    #pipeline-table.show-mp .mp { display:inline; }
    
    .metric-dashboard { display:grid; grid-template-columns:112px minmax(0,1fr); gap:8px; align-items:stretch; margin:0 0 8px; }
    .metric-toggle { display:flex; gap:6px; margin:0; }
    .metric-toggle--vertical { flex-direction:column; justify-content:center; }
    .mt-btn { background:var(--surface); color:var(--text-muted); border:1px solid var(--border); border-radius:18px; padding:5px 10px; font-size:13px; cursor:pointer; transition:all 0.15s; text-align:left; }
    .mt-btn:hover { background:var(--surface-raised); color:var(--text-main); }
    .mt-btn.mt-active { background:var(--accent-strong); color:var(--accent-contrast); border-color:var(--accent-strong); font-weight:600; }
    .day-stat td { border-top: 1px solid var(--border); border-bottom: 2px double var(--border); background: var(--surface); color: var(--text-main); }
    .day-stat-label { text-align: right; color: var(--text-muted); font-weight: normal; }
    .font-bold { font-weight: bold; }
    .pagination-bar { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 8px; padding: 5px 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
    .pag-btn { color: var(--accent); border: 1px solid var(--border); padding: 4px 9px; border-radius: 6px; text-decoration: none; font-size: 12px; background: var(--surface-sunken); transition: background 0.2s, border-color 0.2s; }
    .pag-btn:hover:not(.disabled) { background: var(--surface-raised); border-color: var(--text-muted); }
    .pag-btn.disabled { color: var(--text-muted); border-color: var(--surface-raised); background: var(--surface-sunken); cursor: not-allowed; }
    .pag-current { font-weight: 700; color: var(--text-header); font-size: 14px; }
    .metric-chart { position:relative; margin:8px 0 0; padding:0; background:transparent; border:0; border-radius:0; }
    .metric-chart svg { width:100%; height:188px; display:block; }
    .metric-chart text { fill:var(--text-muted); font-size:13px; }
    .chart-grid { stroke:var(--border-soft); stroke-width:1; opacity:.75; }
    .chart-line { vector-effect: non-scaling-stroke; }
    .metric-chart__legend { display:flex; flex-wrap:wrap; gap:11px; margin:11px 0 0; color:var(--text-main); font-size:15px; }
    .metric-chart__legend em { margin-left:4px; color:var(--text-muted); font-size:12px; font-style:normal; }
    .metric-chart__legend span { display:inline-flex; align-items:center; gap:5px; }
    .metric-chart__legend i { display:inline-block; width:9px; height:9px; border-radius:50%; }
    .metric-chart__hint { display:none; }
    .chart-point { vector-effect: non-scaling-stroke; stroke:var(--bg-color); stroke-width:1.4; }
    .chart-hit { fill:transparent; cursor:crosshair; }
    .chart-tooltip { position:fixed; z-index:50; pointer-events:none; max-width:280px; padding:7px 9px; background:var(--surface); border:1px solid var(--accent); border-radius:6px; color:var(--text-header); font-size:12px; box-shadow:0 8px 24px var(--tooltip-shadow); white-space:nowrap; }
    
    .metric-link { text-decoration: none; }
    .video-dashboard { padding:10px; }
    .video-stats { margin:0 0 10px; }
    .video-dashboard small { color:var(--text-muted); }
    .video-chart { margin:0 0 10px; }
    .video-chart-note { margin:0 0 10px; }
    .video-chart-labels { display:flex; justify-content:space-between; color:var(--text-muted); font-size:11px; }
    .danger { color:var(--danger); font-weight:700; }
    .studio-locale { display:flex; justify-content:flex-end; gap:6px; margin:0 0 6px; }
    .studio-locale a { border:1px solid var(--border); border-radius:14px; padding:3px 9px; font-size:13px; text-decoration:none; }
    .studio-locale a.active { background:var(--accent-strong); border-color:var(--accent-strong); color:var(--accent-contrast); }
    .studio-analytics { white-space:normal; line-height:1.6; }
    .attention-list, .notification-list { list-style:none; margin:0; padding:0; }
    .attention-list li { padding:6px 0; border-bottom:1px solid var(--surface-raised); }
    .notification-list li { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid var(--surface-raised); }
    .notification-list li:last-child { border-bottom:0; }
    .notification-list span { flex:1; }
    .notification-list time { color:var(--text-muted); font-size:12px; white-space:nowrap; }
    .notification--warn span, .notification--error span { color:var(--danger); }

    /* Overview-specific surface. Rules shared with the other tabs (body, main,
       .dashboard-tabs, .metric-chart, ...) are declared once above; only
       selectors unique to this screen belong here. */
    .pipeline-overview { padding:0; background:transparent; border:0; border-radius:0; overflow:visible; }
    /* Trailing cluster of the tab bar: period controls (overview only) plus the
     * theme switch. It owns the margin-left:auto so that the switch stays on
     * the right edge on tabs that render no period controls. */
    .dashboard-tabs__end { display:flex; align-items:center; gap:18px; margin-left:auto; padding-bottom:10px; }
    .dashboard-nav__controls { display:flex; align-items:center; gap:18px; padding-bottom:10px; }
    .period-controls { display:flex; padding:3px; border:1px solid var(--border-soft); border-radius:8px; background:var(--scrim-soft); }
    .dashboard-tabs .period-btn { padding:6px 11px; border-radius:5px; color:var(--text-secondary); text-decoration:none; font-size:14px; font-weight:650; }
    .period-btn.active { background:var(--accent-glow); color:var(--accent-soft-text); }
    .period-range { display:flex; gap:11px; align-items:center; color:var(--text-secondary); font-size:15px; }
    .period-range strong { color:var(--text-main); font-weight:600; min-width:138px; text-align:center; }
    .period-nav { color:var(--text-secondary); text-decoration:none; font-size:23px; line-height:20px; } .period-nav.muted { opacity:.28; }
    .kpi-row { display:grid; grid-template-columns:repeat(4,1fr); margin:0 0 20px; border-bottom:1px solid var(--border-soft); }
    .kpi-row > div { padding:10px 26px 15px; min-width:0; } .kpi-row > div + div { border-left:1px solid var(--border-soft); }
    .kpi-row span,.section-kicker { display:block; color:var(--text-muted); font-size:14px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
    .kpi-row strong { display:block; color:var(--text-header); font-size:54px; line-height:1.05; font-weight:500; letter-spacing:-.055em; }
    .kpi-row .kpi > span { margin-top:7px; color:var(--text-main); font-size:17px; font-weight:500; letter-spacing:0; text-transform:none; }
    .kpi-breakdown { display:block; margin-top:8px; color:var(--text-secondary); font-size:13px; font-style:normal; font-weight:500; white-space:nowrap; }
    .kpi-breakdown + .kpi-delta { margin-top:4px; }
    .kpi-delta { display:block; margin-top:8px; color:var(--accent); font-size:15px; font-style:normal; font-weight:650; } .kpi-delta--down { color:var(--danger-strong); } .kpi-delta i { margin-left:7px; color:var(--text-muted); font-style:normal; font-weight:400; }
    .insights-row { display:grid; grid-template-columns:minmax(210px,.31fr) minmax(0,.69fr); gap:34px; padding-bottom:22px; border-bottom:1px solid var(--border-soft); }
    .audience-panel,.chart-panel { padding:0; background:transparent; border:0; }
    .audience-list { margin-top:10px; } .audience-line { display:flex; align-items:center; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border-soft); font-size:17px; }
    .audience-line__label { display:inline-flex; align-items:center; gap:12px; } .audience-line__label i { display:inline-flex; width:24px; height:24px; align-items:center; justify-content:center; color:var(--text-main); font-style:normal; } .audience-line__label svg { width:22px; height:22px; }
    .audience-line span { color:var(--text-main); } .audience-line strong { color:var(--text-main); font-size:18px; font-weight:600; }
    .audience-line--interactive { color:inherit; text-decoration:none; transition:background .14s ease,box-shadow .14s ease; }
    .audience-line--interactive:hover { background:var(--surface-raised); }
    .audience-line--active { box-shadow:inset 3px 0 0 var(--accent); background:var(--surface-sunken); }
    .audience-line--total { border-top:1px solid var(--border); }
    .audience-all-icon { font-size:18px; font-weight:700; }
    .publication-columns { display:grid; grid-template-columns:minmax(340px,.3fr) minmax(0,.7fr); gap:30px; padding-top:20px; }
    .best-posts,.recent-posts { min-width:0; padding:0; border:0; border-radius:0; background:transparent; } .recent-posts { padding-left:34px; border-left:1px solid var(--border-soft); }
    .best-post { display:grid; grid-template-columns:39px minmax(0,1fr) 92px; gap:13px; align-items:start; padding:14px 0; border-bottom:1px solid var(--border-soft); color:inherit; text-decoration:none; transition:background .14s ease; }
    a.best-post:hover { background:var(--surface-raised); }
    .post-rank { color:var(--accent); font-size:31px; line-height:1; font-weight:500; padding-top:1px; }
    .best-post__title { color:var(--text-main); font-size:16px; line-height:1.4; } .best-post__stats { text-align:right; white-space:nowrap; } .best-post__stats strong { display:block; color:var(--text-header); font-size:18px; font-weight:600; } .best-post__stats small { display:block; color:var(--text-muted); font-size:12px; } .best-post__stats em { display:block; margin-top:8px; color:var(--danger-strong); font-size:14px; font-style:normal; }
    .empty-state { color:var(--text-muted); font-size:14px; }
    /* The title column carries a floor rather than minmax(0,1fr). With a zero
     * minimum the four fixed columns (170 + 3x120 + gaps) can consume the whole
     * row, the first track resolves to 0px, and every post title in the list
     * renders at zero width — invisible, with no overflow to hint at it. */
    .recent-posts__header,.post-detail__summary { display:grid; grid-template-columns:minmax(150px,1fr) 170px repeat(3,120px); align-items:center; gap:14px; }
    .recent-posts__header { padding:0 0 14px; border-bottom:1px solid var(--border-soft); color:var(--text-secondary); font-size:14px; } .recent-posts__header > span { text-align:right; }
    .post-detail { margin:0; border:0; border-bottom:1px solid var(--border-soft); border-radius:0; background:transparent; }
    .post-detail--more { display:none; }
    .recent-posts--expanded .post-detail--more { display:block; }
    .show-more-posts { display:block; margin:14px auto 0; padding:7px 14px; border:1px solid var(--border-soft); border-radius:6px; background:transparent; color:var(--accent-soft-text); font:inherit; font-size:14px; font-weight:650; cursor:pointer; }
    .show-more-posts:hover { background:var(--surface-raised); border-color:var(--accent); }
    .show-more-posts span { color:var(--text-muted); font-weight:500; }
    .post-detail > summary { padding:13px 0; color:inherit; font-size:inherit; font-weight:400; list-style:none; cursor:pointer; } .post-detail > summary::-webkit-details-marker { display:none; }
    .post-detail__summary { font-size:16px; }
    .post-detail__headline { display:grid; grid-template-columns:24px minmax(0,1fr); align-items:center; gap:14px; min-width:0; }
    .post-detail__chevron { color:var(--text-main); font-size:22px; line-height:12px; transform:rotate(0deg); transition:transform .15s; } .post-detail[open] .post-detail__chevron { transform:rotate(90deg); }
    .post-detail__title { color:var(--text-main); font-size:17px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .post-detail__media { color:var(--text-secondary); text-align:right; }
    .post-detail__summary > span:nth-last-child(-n+4) { color:var(--text-main); text-align:right; } .post-detail__body { padding:0 0 22px; }
    .post-platforms { padding:12px 0 17px 38px; border-bottom:1px solid var(--border-soft); } .post-platforms__grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(214px,1fr)); gap:8px; margin-top:10px; }
    .post-platform { display:flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; padding:8px 10px; border:1px solid var(--border-soft); border-radius:6px; background:var(--scrim-soft); color:var(--text-main); font-size:13px; text-decoration:none; } a.post-platform:hover { border-color:var(--accent); }
    .post-platform__name { display:inline-flex; align-items:center; gap:7px; min-width:0; font-weight:600; } .post-platform__name svg { width:16px; height:16px; flex:0 0 auto; } .post-platform__name > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .post-platform__metrics { color:var(--text-secondary); font-size:12px; white-space:nowrap; } .post-platform__metrics b { color:var(--text-main); font-weight:600; }
    .post-detail__content { display:grid; grid-template-columns:minmax(0,1fr) 132px; gap:22px; padding:18px 0 0 38px; }
    .post-detail__body p { margin:5px 0 16px; color:var(--text-main); font-size:16px; line-height:1.5; white-space:pre-wrap; } .post-detail__label { color:var(--text-muted); font-size:13px; font-weight:700; letter-spacing:.1em; }
    .post-preview { display:flex; width:132px; height:108px; align-items:center; justify-content:center; overflow:hidden; background:var(--surface-sunken); color:var(--text-secondary); text-decoration:none; font-size:13px; } .post-preview img { width:100%; height:100%; object-fit:cover; }
    .post-preview--empty { border:1px solid var(--border-soft); }

    /* Between the phone breakpoint and a wide desktop the two-column split is
     * what starved the title column: .publication-columns holds the left side
     * at a 340px minimum, so on a ~900px window the right side has less room
     * than its own fixed columns need. Stack them before that happens rather
     * than letting the list overflow. */
    @media (max-width: 1180px) {
      .insights-row,.publication-columns { grid-template-columns:1fr; gap:28px; }
      .recent-posts { padding-left:0; border-left:0; }
    }

    @media (max-width: 760px) {
      body { padding:10px; }
      main { max-width:none; }
      .metric-dashboard { grid-template-columns:1fr; }
      .metric-toggle--vertical { flex-direction:row; justify-content:flex-start; }
      .pagination-bar { align-items:stretch; flex-wrap:wrap; justify-content:center; }
      .pag-current { flex:1 1 100%; text-align:center; }
      .dashboard-tabs { gap:10px; } .dashboard-tabs__end { width:100%; margin-left:0; align-items:flex-start; justify-content:space-between; gap:10px; padding-top:2px; } .dashboard-nav__controls { width:calc(100% - 32px); flex-wrap:wrap; gap:8px; padding-top:2px; } .period-range { width:100%; justify-content:center; } .kpi-row { grid-template-columns:repeat(2,1fr); }
      .kpi-row > div { padding-left:16px; padding-right:16px; } .kpi-breakdown { white-space:normal; }
      .kpi-row > div:nth-child(3) { border-left:0; border-top:1px solid var(--border-soft); } .kpi-row > div:nth-child(4) { border-top:1px solid var(--border-soft); }
      .insights-row,.publication-columns { grid-template-columns:1fr; gap:28px; } .recent-posts { padding-left:0; border-left:0; } .recent-posts__header { grid-template-columns:minmax(0,1fr) auto; } .recent-posts__header > span:nth-last-child(-n+2) { display:none; } .post-detail__summary { grid-template-columns:minmax(0,1fr) auto; } .post-detail__summary > span:nth-last-child(-n+2) { display:none; } .post-detail__media { display:none; } .post-platforms,.post-detail__content { padding-left:0; } .post-platforms__grid { grid-template-columns:1fr; } .post-detail__content { grid-template-columns:1fr; } .post-preview { display:none; }
    }
  </style>
</head>
<body>
<main>
  ${body}
</main>
<script>
${DASHBOARD_THEME_TOGGLE_SCRIPT}
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
  document.querySelectorAll('.show-more-posts').forEach((button) => {
    button.addEventListener('click', () => {
      button.closest('.recent-posts')?.classList.add('recent-posts--expanded');
      button.remove();
    });
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
