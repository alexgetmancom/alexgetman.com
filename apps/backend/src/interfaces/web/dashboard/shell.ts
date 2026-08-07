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

    /* The family matches the reference layout; the line-height deliberately does
       not. 1.5 belongs to the editorial overview and is set on .overview-track —
       applied here it would also loosen the dense ops tables below. */
    body { margin:0; padding:24px; background:var(--bg-color); color:var(--text-main); font:400 16px ui-sans-serif,-apple-system,"Inter","Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
    main { max-width:1440px; margin:0 auto; }
    main.dashboard-loading { opacity:.62; transition:opacity .12s ease; }
    h1,h2 { color:var(--text-header); }
    .theme-toggle { width:30px; height:30px; padding:0; border:1px solid var(--border); border-radius:50%; background:var(--surface); color:var(--text-secondary); font-size:14px; line-height:1; cursor:pointer; }
    .theme-toggle:hover { border-color:var(--border-hover); color:var(--text-header); }
    .dashboard-heading { margin-bottom:12px; }
    .dashboard-heading h1 { margin-bottom:4px; }
    /* Two columns, not three: the bar used to carry a center slot for the
       content-type filter, and with that filter gone the leftover middle
       column left the period controls parked short of the right edge instead
       of flush against the theme toggle. */
    .dashboard-tabs { display:grid; grid-template-columns:auto 1fr; align-items:center; gap:16px; margin:0 0 14px; border-bottom:1px solid var(--border-soft); }
    .dashboard-tabs__start > a { padding:0 0 9px; border:0; border-radius:0; background:transparent; color:var(--text-muted); font-size:16px; font-weight:600; text-decoration:none; }
    .dashboard-tabs__start > a:hover { color:var(--text-main); }
    .dashboard-tabs__start > a.active { color:var(--text-header); box-shadow:inset 0 -2px var(--accent); }

    /* The rarely-opened sections collapse into one control. A native <details>
       carries the open state without script; only closing it on an outside
       click needs JS. */
    .nav-more { position:relative; margin:0 0 9px; border:0; border-radius:0; background:transparent; }
    .nav-more__toggle { display:inline-flex; align-items:center; gap:6px; padding:2px 9px; border:1px solid transparent; border-radius:7px; color:var(--text-muted); font-size:16px; font-weight:600; line-height:1.25; list-style:none; cursor:pointer; }
    .nav-more__toggle::-webkit-details-marker { display:none; }
    .nav-more__toggle:hover { border-color:var(--border); color:var(--text-main); }
    .nav-more__toggle.active { color:var(--text-header); }
    /* Health is behind the menu, so its state has to reach the closed control. */
    .nav-more__toggle--attention::after { content:""; width:7px; height:7px; border-radius:50%; background:var(--danger); }
    .nav-more__menu { position:absolute; z-index:20; top:calc(100% + 6px); left:0; display:flex; flex-direction:column; min-width:172px; padding:5px; border:1px solid var(--border); border-radius:9px; background:var(--surface); box-shadow:0 10px 30px var(--tooltip-shadow); }
    .nav-more__menu a { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 10px; border-radius:6px; color:var(--text-main); font-size:15px; font-weight:500; text-decoration:none; }
    .nav-more__menu a:hover { background:var(--surface-raised); }
    .nav-more__menu a.active { background:var(--accent-glow); color:var(--accent-soft-text); font-weight:650; }
    .nav-dot { width:7px; height:7px; border-radius:50%; background:var(--danger); }
    .overview { padding:0; border:0; background:transparent; overflow:visible; }
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
    
    .day-stat td { border-top: 1px solid var(--border); border-bottom: 2px double var(--border); background: var(--surface); color: var(--text-main); }
    .day-stat-label { text-align: right; color: var(--text-muted); font-weight: normal; }
    .font-bold { font-weight: bold; }
    .chart-hit { fill:transparent; cursor:crosshair; }
    .chart-tooltip { position:fixed; z-index:50; pointer-events:none; max-width:280px; padding:7px 9px; background:var(--surface); border:1px solid var(--accent); border-radius:6px; color:var(--text-header); font-size:12px; box-shadow:0 8px 24px var(--tooltip-shadow); white-space:nowrap; }
    
    .metric-link { text-decoration: none; }
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
       and .dashboard-tabs) are declared once above; only
       selectors unique to this screen belong here. */
    .pipeline-overview { padding:0; background:transparent; border:0; border-radius:0; overflow:visible; }
    /* Trailing cluster of the tab bar: period controls (overview only) plus the
     * theme switch. It owns the margin-left:auto so that the switch stays on
     * the right edge on tabs that render no period controls. */
    /* Three clusters: sections left, the content filter centred on the page,
       period and date pinned right. The centre track is what keeps the filter
       on the page axis rather than wherever the left cluster happens to end. */
    .dashboard-tabs__start { display:flex; align-items:center; gap:16px; }
    .dashboard-tabs__center { display:flex; justify-content:center; padding-bottom:8px; }
    .dashboard-tabs__end { display:flex; align-items:center; justify-content:flex-end; gap:12px; padding-bottom:8px; }
    .dashboard-nav__controls { display:flex; align-items:center; gap:12px; padding-bottom:0; }
    .period-menu { position:relative; margin:0; border:0; border-radius:0; background:transparent; }
    .period-menu__toggle { display:inline-flex; align-items:center; gap:5px; padding:4px 9px; border:1px solid var(--border-soft); border-radius:7px; color:var(--text-secondary); font-size:14px; font-weight:650; line-height:1.3; list-style:none; cursor:pointer; }
    .period-menu__toggle::-webkit-details-marker { display:none; }
    .period-menu__toggle:hover { border-color:var(--border); color:var(--text-main); }
    .period-menu__toggle .caret { font-size:9px; font-style:normal; opacity:.6; }
    .period-menu__list { position:absolute; z-index:20; top:calc(100% + 6px); right:0; display:flex; flex-direction:column; min-width:96px; padding:5px; border:1px solid var(--border); border-radius:9px; background:var(--surface); box-shadow:0 10px 30px var(--tooltip-shadow); }
    .period-menu__list a { padding:6px 10px; border-radius:6px; color:var(--text-main); font-size:14px; font-weight:500; text-decoration:none; }
    .period-menu__list a:hover { background:var(--surface-raised); }
    .period-menu__list a.active { background:var(--accent-glow); color:var(--accent-soft-text); font-weight:650; }
    .period-range { display:flex; gap:8px; align-items:center; color:var(--text-secondary); font-size:14px; }
    .period-range span { min-width:104px; text-align:center; }
    .period-nav { color:var(--text-muted); text-decoration:none; font-size:18px; line-height:16px; } .period-nav:hover { color:var(--text-main); } .period-nav.muted { opacity:.28; }
    /* Unified overview: one filter, one period, both feeds.
       The mode switch reuses the period-control shape so the two read as one
       row of filters rather than as two unrelated widgets. */
    .mode-filter { display:inline-flex; gap:3px; padding:3px; border:1px solid var(--border-soft); border-radius:8px; background:var(--scrim-soft); }
    .dashboard-tabs .mode-btn { padding:6px 13px; border-radius:5px; color:var(--text-secondary); text-decoration:none; font-size:14px; font-weight:650; }
    .dashboard-tabs .mode-btn:hover { color:var(--text-main); }
    .mode-btn--active { background:var(--accent-glow); color:var(--accent-soft-text); }

    /* The landing hero separates content types before the rest of the overview
       explains platforms and publications. It is one flat overview band, not a
       card inside a card: the page surface and the separators are shared with
       the platform and chart bands below it. */
    .hero-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0; margin:0 0 22px; padding:0 0 22px; border:0; border-bottom:1px solid var(--border-soft); border-radius:0; overflow:visible; background:transparent; }
    .hero-card { min-width:0; padding:14px 0 12px; border:0; border-radius:0; background:transparent; }
    .hero-card:first-child { padding-right:26px; }
    .hero-card + .hero-card { padding-left:26px; border-left:1px solid var(--border-soft); }
    .hero-card__heading { display:flex; align-items:center; gap:8px; color:var(--text-secondary); font-size:14px; }
    .hero-card__heading i { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
    .hero-card__heading strong { color:var(--text-main); font-size:16px; letter-spacing:.04em; }
    .hero-card__heading span { color:var(--text-secondary); }
    .hero-card__primary { display:grid; grid-template-columns:minmax(0,1fr) minmax(94px,.5fr) auto; align-items:end; gap:18px; padding:17px 0 11px; border-bottom:1px solid var(--border-soft); }
    .hero-card__views span,.hero-card__median span,.hero-card__metric span { display:block; color:var(--text-secondary); font-size:13px; }
    .hero-card__views strong { display:block; margin-top:2px; color:var(--text-header); font-size:42px; line-height:1; font-weight:500; letter-spacing:-.055em; }
    .hero-card__median { align-self:center; }
    .hero-card__median strong { display:block; margin-top:7px; color:var(--text-main); font-size:22px; line-height:1; font-weight:500; }
    .hero-card__delta { align-self:center; color:var(--text-muted); font-size:14px; font-weight:650; white-space:nowrap; }
    .hero-card__delta--up { color:var(--accent); }
    .hero-card__delta--down { color:var(--danger-strong); }
    .hero-card__secondary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
    .hero-card--video .hero-card__secondary { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .hero-card__metric { min-width:0; padding:10px 12px 0 0; }
    .hero-card__metric + .hero-card__metric { padding-left:12px; border-left:1px solid var(--border-soft); }
    .hero-card__metric strong { display:block; margin-top:5px; color:var(--text-header); font-size:23px; line-height:1; font-weight:550; white-space:nowrap; }

    .platform-metric-filter { display:inline-flex; flex:0 0 auto; gap:2px; padding:2px; border:1px solid var(--border-soft); border-radius:7px; background:var(--scrim-soft); }
    .platform-metric-btn { padding:4px 8px; border-radius:5px; color:var(--text-muted); font-size:12px; font-weight:650; text-decoration:none; }
    .platform-metric-btn:hover { color:var(--text-main); }
    .platform-metric-btn--active { background:var(--accent-glow); color:var(--accent-soft-text); }
    .platform-mark { display:inline-flex; color:var(--text-muted); }
    .platform-mark svg { width:15px; height:15px; }
    .post-detail__media { display:flex; gap:8px; justify-content:flex-end; }
    .post-detail--flat { display:block; color:inherit; text-decoration:none; }
    a.post-detail--flat:hover .post-detail__title { color:var(--accent); }
    .post-detail--flat .post-detail__summary { padding:13px 0; }
    .post-detail__chevron--link { font-size:17px; line-height:1; }

    .empty-state { color:var(--text-muted); font-size:14px; }
    /* The title column carries a floor rather than minmax(0,1fr). With a zero
     * minimum the four fixed columns (170 + 3x120 + gaps) can consume the whole
     * row, the first track resolves to 0px, and every post title in the list
     * renders at zero width — invisible, with no overflow to hint at it. */
    .post-detail__summary { display:grid; grid-template-columns:minmax(150px,1fr) 170px repeat(3,120px); align-items:center; gap:14px; }
    .post-detail { margin:0; border:0; border-bottom:1px solid var(--border-soft); border-radius:0; background:transparent; }
    .post-detail--more { display:none; }
    .show-more-posts { display:block; margin:14px auto 0; padding:7px 14px; border:1px solid var(--border-soft); border-radius:6px; background:transparent; color:var(--accent-soft-text); font:inherit; font-size:14px; font-weight:650; cursor:pointer; }
    .show-more-posts:hover { background:var(--surface-raised); border-color:var(--accent); }
    .show-more-posts span { color:var(--text-muted); font-weight:500; }
    .post-detail > summary { padding:13px 0; color:inherit; font-size:inherit; font-weight:400; list-style:none; cursor:pointer; } .post-detail > summary::-webkit-details-marker { display:none; }
    .post-detail__summary { font-size:16px; }
    .post-detail__headline { display:grid; grid-template-columns:24px minmax(0,1fr); align-items:center; gap:14px; min-width:0; }
    .post-detail__chevron { color:var(--text-main); font-size:22px; line-height:12px; transform:rotate(0deg); transition:transform .15s; } .post-detail[open] .post-detail__chevron { transform:rotate(90deg); }
    .post-detail__title { color:var(--text-main); font-size:17px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .post-detail__media { display:flex; align-items:center; justify-content:flex-end; gap:6px; color:var(--text-secondary); text-align:right; } .post-detail__platform-summary { position:relative; display:inline-flex; align-items:center; justify-content:center; min-width:0; color:var(--text-secondary); outline:none; } .post-detail__platform-summary--count { width:22px; height:22px; cursor:help; } .post-detail__platform-locale { padding:1px 4px; border:1px solid var(--border-soft); border-radius:4px; color:var(--text-muted); font-size:10px; font-weight:700; letter-spacing:.04em; white-space:nowrap; } .post-detail__platform-count { display:inline-flex; width:20px; height:20px; align-items:center; justify-content:center; border:1px solid var(--border-soft); border-radius:4px; color:var(--text-main); font-size:12px; font-weight:650; line-height:1; } .post-detail__platform-tooltip { position:absolute; z-index:20; top:calc(100% + 7px); right:0; display:grid; grid-template-columns:repeat(2,minmax(118px,1fr)); gap:12px; min-width:236px; max-width:340px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); box-shadow:0 10px 30px var(--tooltip-shadow); color:var(--text-main); cursor:default; opacity:0; pointer-events:none; visibility:hidden; transform:translateY(-3px); transition:opacity .12s ease, transform .12s ease, visibility .12s ease; text-align:left; } .post-detail__platform-summary:hover .post-detail__platform-tooltip, .post-detail__platform-summary:focus-visible .post-detail__platform-tooltip { opacity:1; pointer-events:auto; visibility:visible; transform:translateY(0); } .post-detail__platform-tooltip-column { min-width:0; } .post-detail__platform-tooltip-column > b { display:block; margin-bottom:6px; color:var(--text-muted); font-size:11px; font-weight:700; letter-spacing:.08em; } .post-detail__platform-tooltip-column ul { display:flex; flex-direction:column; gap:5px; margin:0; padding:0; list-style:none; } .post-detail__platform-tooltip-column li { display:flex; align-items:center; gap:6px; min-width:0; color:var(--text-main); font-size:12px; white-space:nowrap; } .post-detail__platform-tooltip-column li .platform-mark { display:inline-flex; width:15px; height:15px; flex:0 0 auto; color:var(--text-muted); } .post-detail__platform-tooltip-column li .platform-mark svg { width:15px; height:15px; }
    .post-detail__metric { display:flex; min-width:0; align-items:baseline; justify-content:flex-end; gap:5px; color:var(--text-main); font-variant-numeric:tabular-nums; text-align:right; white-space:nowrap; }
    .post-detail__lifetime { color:var(--text-muted); font-size:11px; white-space:nowrap; }
    .overview-publications__list .post-detail__lifetime { justify-content:flex-start; }
    .post-detail__summary > span:nth-last-child(-n+4) { color:var(--text-main); text-align:right; } .post-detail__body { padding:0 0 22px; }
    .post-platforms { padding:12px 0 17px 38px; border-bottom:1px solid var(--border-soft); } .post-platforms__grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(214px,1fr)); gap:8px; margin-top:10px; }
    .post-platform { display:grid; grid-template-columns:minmax(0,1fr) 174px; align-items:center; gap:10px; min-width:0; padding:8px 10px; border:1px solid var(--border-soft); border-radius:6px; background:var(--scrim-soft); color:var(--text-main); font-size:13px; text-decoration:none; } a.post-platform:hover { border-color:var(--accent); }
    .post-platform__name { display:inline-flex; align-items:center; gap:7px; min-width:0; font-weight:600; } .post-platform__name svg { width:16px; height:16px; flex:0 0 auto; } .post-platform__locale { flex:none; padding:1px 5px; border:1px solid var(--border-soft); border-radius:4px; color:var(--text-muted); font-size:11px; font-weight:500; letter-spacing:.08em; } .post-platform__metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; min-width:0; color:var(--text-secondary); font-size:12px; } .post-platform__metric { min-width:0; color:var(--text-main); text-align:right; } .post-platform__metric b { font-weight:600; }
    .post-detail__content { display:block; padding:18px 0 0 38px; }
    .post-detail__body p { margin:5px 0 16px; color:var(--text-main); font-size:16px; line-height:1.5; white-space:pre-wrap; } .post-detail__label { color:var(--text-muted); font-size:13px; font-weight:700; letter-spacing:.1em; }

    @media (max-width: 760px) {
      body { padding:10px; }
      main { max-width:none; }
      .hero-metrics { grid-template-columns:1fr; }
      .hero-card:first-child { padding-right:0; }
      .hero-card + .hero-card { padding-left:0; border-left:0; border-top:1px solid var(--border-soft); }
      .hero-card__primary { grid-template-columns:minmax(0,1fr) minmax(86px,.6fr) auto; gap:12px; }
      .hero-card__views strong { font-size:36px; }
      .dashboard-tabs { grid-template-columns:1fr; gap:10px; }
      .dashboard-tabs__end { width:100%; margin-left:0; align-items:flex-start; justify-content:space-between; gap:10px; padding-top:2px; } .dashboard-nav__controls { width:calc(100% - 32px); flex-wrap:wrap; gap:8px; padding-top:2px; } .period-range { width:100%; justify-content:center; }
      .post-detail__summary { grid-template-columns:minmax(0,1fr) auto; } .post-detail__summary > span:nth-last-child(-n+2) { display:none; } .post-detail__media { display:none; } .post-platforms,.post-detail__content { padding-left:0; } .post-platforms__grid { grid-template-columns:1fr; }
    }

    /* Split overview skin. The data remains server-rendered and the operations
       sections keep their denser treatment; only the landing screen becomes
       editorial and calm. */
    body { padding:30px 36px 90px; }
    /* 1340 is the outer measure, body padding included — the same 1268px of
       content the reference layout gets from a border-box wrapper. */
    main { max-width:1268px; margin:0 auto; }
    .pipeline-overview { margin:0; }
    .overview-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); min-width:0; }
    /* The track is a column of a split, not a card. It is a <section> only
       because it is a landmark, and the generic section rule above dresses every
       section as a panel — here that drew a frame and a raised surface around
       each half, which is exactly the chrome this screen is meant to drop. */
    .overview-track { min-width:0; padding:0; border:0; border-radius:0; background:transparent; overflow:visible; line-height:1.5; }
    .overview-track--text { padding-right:38px; }
    .overview-track--video { padding-left:38px; border-left:1px solid var(--border-soft); }
    .overview-split--single .overview-track { padding-left:0; padding-right:0; border-left:0; }
    .overview-track .hero-card { min-width:0; margin:0; padding:0; border:0; border-radius:0; background:transparent; }
    /* No min-height. The dashboard does not set a global border-box, so 48px of
       declared minimum landed on top of the 26px of padding and opened a 27px
       band of nothing between the heading rule and the number under it. The two
       headings hold the same one line of text, so nothing needed equalising. */
    .overview-hero-card__heading { position:sticky; top:0; z-index:5; display:flex; align-items:baseline; gap:11px; padding:12px 0 14px; border-bottom:1px solid var(--border-soft); background:var(--bg-color); }
    .overview-hero-card__heading::after { content:""; position:absolute; right:0; bottom:-1px; left:0; height:2px; border-radius:99px; background:var(--series-text); opacity:.68; transform-origin:left center; transform:scaleX(var(--hero-progress,0)); }
    .hero-card--video .overview-hero-card__heading::after { background:var(--series-video); }
    .overview-hero-card__heading i { width:9px; height:9px; border-radius:50%; flex:0 0 auto; transform:translateY(-1px); }
    .hero-card--video .overview-hero-card__heading--win::after,
    .overview-hero-card__heading--win::after { background:var(--success); opacity:.85; }
    .overview-hero-card__heading strong { color:var(--text-header); font-size:14px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; }
    .overview-hero-card__heading span { margin-left:auto; color:var(--text-secondary); font-size:14px; font-weight:400; }
    .overview-hero-card__primary { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:20px; padding:24px 0 10px; border:0; }
    .overview-hero-card__views strong { display:inline-block; margin:0; color:var(--text-header); font-size:58px; line-height:1; font-weight:500; letter-spacing:-.03em; }
    .overview-hero-card__views .hero-card__delta { display:inline-block; margin:0 0 7px 14px; vertical-align:baseline; font-size:16px; font-style:normal; font-weight:500; }
    /* One line, not a stacked label and value: the norm is an aside to the big
       number, and stacked it read as a second KPI competing with it. */
    .overview-hero-card__median { align-self:end; padding-bottom:7px; text-align:right; }
    .overview-hero-card__median span { display:inline; color:var(--text-secondary); font-size:14px; font-variant-numeric:tabular-nums; }
    .overview-hero-card__median b { color:var(--text-main); font-weight:500; }
    .overview-hero-card__context { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:22px; color:var(--text-secondary); font-size:12px; font-weight:500; letter-spacing:.15em; text-transform:uppercase; }
    .overview-hero-card__pace { color:var(--text-secondary); font-size:14px; letter-spacing:0; text-transform:none; text-align:right; }
    .overview-hero-card__pace--positive { color:var(--success); }
    .hero-card__delta--up { color:var(--success); }
    .hero-card__delta--down { color:var(--danger-strong); }
    .hero-card__delta--flat { color:var(--text-muted); }
    .overview-spark { margin:0 0 25px; }
    .overview-spark svg { display:block; width:100%; height:52px; overflow:visible; }
    .overview-spark__cap { stroke:var(--text-muted); stroke-dasharray:2 4; stroke-width:1; opacity:.72; }
    .overview-spark__cap-label { fill:var(--text-muted); font-size:10px; font-variant-numeric:tabular-nums; }
    .overview-spark__average { stroke:var(--text-muted); stroke-dasharray:3 5; stroke-width:1; opacity:.72; }
    .overview-spark__bar--over-cap { filter:brightness(1.25); }
    .overview-spark__bar--partial { stroke:var(--text-muted); stroke-dasharray:2 3; stroke-width:1; }
    .overview-spark__cohort { stroke:var(--surface); stroke-width:1; opacity:.85; }
    .overview-spark__footer { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-top:8px; color:var(--text-secondary); font-size:13px; font-variant-numeric:tabular-nums; }
    .overview-spark__footer span:nth-child(2) { color:var(--text-secondary); }
    .overview-spark__footer b { color:var(--text-main); font-weight:600; }
    .overview-micro { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; margin:0 0 30px; color:var(--text-secondary); font-size:15px; font-variant-numeric:tabular-nums; }
    .overview-micro b { color:var(--text-main); font-weight:500; }
    .overview-micro__separator { color:var(--text-muted); }
    .overview-track__filter { display:inline-flex; align-items:center; gap:7px; margin:0 0 10px; padding:3px 8px; border:1px solid var(--accent); border-radius:14px; background:var(--accent-glow); color:var(--accent-soft-text); font-size:12px; font-weight:600; text-decoration:none; }
    .overview-track__filter i { font-style:normal; font-size:14px; line-height:1; opacity:.75; }
    .overview-track__filter:hover i { opacity:1; }
    .overview-platform--active { border-radius:6px; box-shadow:inset 0 0 0 1px var(--accent); }
    .overview-platform--active strong { color:var(--accent-soft-text); }
    .overview-kicker { color:var(--text-secondary); font-size:13px; font-weight:600; letter-spacing:.15em; text-transform:uppercase; }
    .overview-platforms { margin:0 0 18px; }
    .overview-platforms__header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .overview-platforms__header em { color:var(--text-muted); font-size:12px; font-style:normal; font-weight:500; letter-spacing:0; text-transform:none; }
    /* Under the bar and over the columns: the same two halves, one label each,
       centred on the column it heads. The expander sits where the EN label used
       to, clear of both. */
    .overview-platforms__bar-labels { position:relative; display:grid; grid-template-columns:1fr 1fr; gap:0 28px; margin-top:9px; color:var(--text-secondary); font-size:13px; letter-spacing:.1em; text-transform:uppercase; }
    .overview-platforms__bar-labels > span { text-align:center; }
    .overview-platforms__all { position:absolute; top:50%; right:0; transform:translateY(-50%); }
    .overview-platforms__all > summary { display:inline-flex; align-items:center; gap:4px; width:auto; height:20px; padding:0 6px; border:1px solid var(--border-soft); border-radius:6px; color:var(--text-secondary); font-size:13px; line-height:1; list-style:none; cursor:pointer; }
    .overview-platforms__all > summary::-webkit-details-marker { display:none; }
    .overview-platforms__all > summary:hover { border-color:var(--border-hover); color:var(--text-main); }
    .overview-platforms__all > summary span { color:var(--text-muted); font-size:11px; }
    .overview-platforms__all[open] > summary { color:var(--text-main); }
    .overview-platforms__all-list { position:absolute; z-index:20; top:calc(100% + 6px); right:0; display:grid; grid-template-columns:1fr 1fr; gap:0 28px; min-width:300px; padding:6px 12px; border:1px solid var(--border); border-radius:9px; background:var(--surface); box-shadow:0 10px 30px var(--tooltip-shadow); }
    .overview-platforms__bar { display:flex; gap:2px; height:10px; overflow:hidden; border-radius:999px; background:var(--border-soft); }
    .overview-platforms__bar i { display:block; min-width:2px; height:100%; transition:filter .15s; }
    .overview-platforms__bar i:hover { filter:brightness(1.08); }
    .overview-platforms__legend { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; color:var(--text-secondary); font-size:14px; font-variant-numeric:tabular-nums; }
    .overview-platforms__legend b { color:var(--text-main); font-weight:500; }
    /* Keep the control below the platform legend on the same baseline in both
       columns, even when one content type has fewer than four destinations. */
    /* Two columns under the bar, читаются как его половины: RU слева, EN справа. */
    /* Height comes from the rows actually drawn, not from a fixed reserve: the
       renderer sets --platform-rows to the tallest column of either half, so the
       two halves stay level and neither pads out empty space. */
    .overview-platforms__rows { display:grid; grid-template-columns:1fr 1fr; gap:0 28px; min-height:calc(var(--platform-rows,3) * 40px); margin-top:6px; }
    .overview-platforms__column { display:flex; flex-direction:column; min-width:0; }
    /* A hairline between the halves, dashed so it separates without ruling. */
    .overview-platforms__column + .overview-platforms__column { margin-left:-14px; padding-left:14px; border-left:1px dashed var(--border-soft); }
    /* No rule between rows: this block is a legend for the bar above it, and
       ruled rows turned it into a table competing with the publication list. */
    /* The source name and locale stay together so the bar can be reconciled
       without opening another panel. */
    .overview-platform { display:grid; grid-template-columns:16px 1fr 48px; gap:10px; align-items:center; padding:8px 0; color:var(--text-main); text-decoration:none; font-variant-numeric:tabular-nums; }
    .overview-platform:hover { background:var(--surface-raised); }
    .overview-platform__icon { display:inline-flex; flex:none; width:16px; height:16px; }
    .overview-platform__name { display:flex; align-items:center; gap:9px; min-width:0; color:var(--text-secondary); font-size:15px; }
    .overview-platform__name b { flex:none; padding:1px 5px; border:1px solid var(--border-soft); border-radius:4px; color:var(--text-muted); font-size:11px; font-weight:500; letter-spacing:.08em; }
    /* An icon, not a text badge — same slot the publication tag held before,
       drawn in the muted colour of the row so it reads as chrome, not brand. */
    .track-publication__tag { display:inline-flex; flex:none; width:16px; height:16px; color:var(--text-muted); }
    .overview-platform > strong { color:var(--text-header); font-size:16px; font-weight:500; text-align:right; }
    .overview-platform__delta { min-width:48px; color:var(--text-muted); font-size:13px; text-align:right; }
    .overview-platform__delta--up { color:var(--success); }
    .overview-platform__delta--down { color:var(--danger-strong); }
    .platform-metric-filter { display:inline-flex; flex:0 0 auto; gap:2px; padding:2px; border:1px solid var(--border-soft); border-radius:7px; background:var(--scrim-soft); }
    .platform-metric-btn { padding:4px 8px; border-radius:5px; color:var(--text-muted); font-size:12px; font-weight:650; text-decoration:none; }
    .platform-metric-btn:hover { color:var(--text-main); }
    .platform-metric-btn--active { background:var(--accent-glow); color:var(--accent-soft-text); }
    /* Inside the overview the metric switch sits between the RU and EN labels,
       so it drops the box and reads as two small links. */
    .overview-platforms__legend .platform-metric-filter { gap:8px; padding:0; border:0; border-radius:0; background:transparent; }
    .overview-platforms__legend .platform-metric-btn { padding:0; border-radius:0; font-size:12px; font-weight:500; letter-spacing:0; text-transform:none; }
    .overview-platforms__legend .platform-metric-btn--active { background:transparent; color:var(--text-main); font-weight:650; }
    .overview-publications { margin-top:2px; }
    .overview-publications .overview-kicker { margin-bottom:9px; }
    .overview-publications__list .post-detail__summary { grid-template-columns:minmax(0,1fr) 92px 68px 56px 48px; gap:10px; }
    /* The video rows carry a sixth figure, the clip's lifetime. Fixed tracks, not
       auto: every row is its own grid, and content-sized columns would settle at
       a different width in each one instead of lining up down the list. */
    .overview-track--video .overview-publications__list .post-detail__summary { grid-template-columns:minmax(0,1fr) 62px 58px 54px 52px 44px; }
    .overview-publications__list .post-detail__title { font-size:15px; font-weight:500; }
    .overview-publications--expanded .post-detail--more { display:block; }
    .track-publication { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:4px 12px; align-items:baseline; padding:14px 0; border-bottom:1px solid var(--border-soft); color:var(--text-main); text-decoration:none; }
    .track-publication:hover { background:var(--surface-raised); }
    .track-publication__title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:16px; }
    .track-publication__stats { display:flex; flex-direction:column; align-items:flex-end; color:var(--text-header); font-size:17px; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .track-publication__stats b { font-weight:500; }
    .track-publication__stats small { color:var(--text-muted); font-size:12px; font-weight:400; }
    .track-publication__meta { grid-column:2 / 3; color:var(--text-secondary); font-size:13px; }
    .track-publication__more { display:block; padding-top:16px; color:var(--text-secondary); font-size:14px; text-decoration:none; }
    .track-publication__more:hover { color:var(--text-main); }
    .overview-chart-tooltip { display:block; }
    .overview-chart-tooltip[hidden] { display:none; }
    /* Compact controls, sized to the reference bar: 2px between the period
       pills, 20px between the three control groups, and a date block that does
       not reserve a column wider than the longest label it shows. */
    .dashboard-tabs__end .dashboard-nav__controls { gap:20px; }
    .period-quick { display:inline-flex; align-items:center; gap:2px; }
    .period-quick-link { padding:5px 13px; border-radius:999px; color:var(--text-secondary); font-size:14px; font-weight:500; text-decoration:none; }
    .period-quick-link:hover { color:var(--text-main); }
    .period-quick-link.active { background:var(--surface-raised); color:var(--text-header); font-weight:500; }
    .dashboard-tabs__end .period-range { gap:12px; }
    .dashboard-tabs__end .period-range span { min-width:0; color:var(--text-header); font-weight:500; }
    .dashboard-tabs__end .period-nav { padding:2px 6px; font-size:16px; line-height:1.2; }
    .dashboard-tabs__end .period-menu__toggle { padding:6px 8px; border:0; }
    /* The overview tab carries no accent underline here. It is the only primary
       tab, so the rule marked nothing the weight and colour did not already say,
       and it collided with the goal gauge under each column heading. */
    .dashboard-tabs__start > a.active { box-shadow:none; }
    /* The mode filter matches the period pills beside it rather than being a
       second, boxed control on the same line. */
    .dashboard-tabs .mode-filter { gap:2px; padding:0; border:0; background:transparent; }
    .dashboard-tabs .mode-btn { padding:7px 12px; border-radius:999px; font-weight:500; }
    .dashboard-tabs .mode-btn--active { background:var(--surface-raised); color:var(--text-header); font-weight:650; }

    @media (max-width: 820px) {
      body { padding:24px 20px 64px; }
      .overview-split { grid-template-columns:1fr; gap:44px; }
      .overview-track--text,.overview-track--video { padding-left:0; padding-right:0; border-left:0; }
      .overview-track--video { border-top:1px solid var(--border-soft); padding-top:44px; }
      .overview-platforms__rows { min-height:0; gap:0 14px; }
    }
    @media (max-width: 760px) {
      body { padding:16px 14px 48px; }
      .overview-hero-card__primary { grid-template-columns:minmax(0,1fr) auto; gap:12px; }
      .overview-hero-card__views strong { font-size:48px; }
      .overview-hero-card__context { align-items:flex-start; flex-direction:column; gap:5px; }
      .overview-hero-card__pace { text-align:left; }
      .overview-platform { grid-template-columns:16px 1fr; }
      .overview-platform__delta { display:none; }
      .track-publication { grid-template-columns:auto minmax(0,1fr); }
      .track-publication__stats { grid-column:2; grid-row:1 / span 2; }
      .track-publication__meta { grid-column:2; }
      .overview-publications__list .post-detail__summary { grid-template-columns:minmax(0,1fr) auto; }
    }
  </style>
</head>
<body>
<main>
  ${body}
</main>
<script>
${DASHBOARD_THEME_TOGGLE_SCRIPT}
  const loadMorePosts = async (button) => {
    const moreUrl = button.dataset.moreUrl;
    if (!moreUrl) {
      button.closest('.overview-publications')?.classList.add('overview-publications--expanded');
      button.remove();
      return;
    }
    if (button.dataset.loading === 'true') return;
    button.dataset.loading = 'true';
    button.disabled = true;
    try {
      const offset = Number(button.dataset.moreOffset || '0');
      const separator = moreUrl.includes('?') ? '&' : '?';
      const response = await fetch(moreUrl + separator + 'offset=' + encodeURIComponent(String(offset)) + '&limit=10', { credentials: 'same-origin' });
      const payload = await response.json();
      if (!response.ok || typeof payload.html !== 'string') throw new Error('publication details request failed');
      button.insertAdjacentHTML('beforebegin', payload.html);
      const loaded = Number(payload.loaded) || 0;
      const remaining = Number(payload.remaining) || 0;
      if (loaded === 0 || remaining === 0) {
        button.remove();
        return;
      }
      button.dataset.moreOffset = String(offset + loaded);
      const count = button.querySelector('span');
      if (count) count.textContent = String(remaining);
      button.disabled = false;
      delete button.dataset.loading;
    } catch {
      button.disabled = false;
      delete button.dataset.loading;
    }
  };
  const bindDashboardInteractions = (root) => {
    if (!root) return;
    root.querySelectorAll('.show-more-posts').forEach((button) => {
      if (button.dataset.bound === 'true') return;
      button.dataset.bound = 'true';
      button.addEventListener('click', () => void loadMorePosts(button));
    });
    const chartTooltip = root.querySelector('.overview-chart-tooltip');
    root.querySelectorAll('.chart-hit, [data-tooltip]').forEach((point) => {
      if (point.dataset.bound === 'true') return;
      point.dataset.bound = 'true';
      point.addEventListener('mouseenter', () => {
        if (!chartTooltip) return;
        chartTooltip.textContent = point.dataset.tooltip || '';
        chartTooltip.hidden = false;
      });
      point.addEventListener('mousemove', (event) => {
        if (!chartTooltip) return;
        chartTooltip.style.left = Math.min(event.clientX + 12, innerWidth - 280) + 'px';
        chartTooltip.style.top = (event.clientY + 12) + 'px';
      });
      point.addEventListener('mouseleave', () => {
        if (chartTooltip) chartTooltip.hidden = true;
      });
    });
  };
  bindDashboardInteractions(document.querySelector('main'));
  const navMenus = () => document.querySelectorAll('.nav-more[open], .period-menu[open]');
  document.addEventListener('click', (event) => {
    navMenus().forEach((menu) => {
      if (event.target instanceof Node && !menu.contains(event.target)) menu.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') navMenus().forEach((menu) => menu.removeAttribute('open'));
  });
  const fragmentCache = new Map();
  const fragmentRequests = new Map();
  const MAX_FRAGMENT_CACHE_ENTRIES = 5;
  const fragmentKey = (url) => url.pathname + url.search;
  const rememberFragment = (key, html) => {
    fragmentCache.delete(key);
    fragmentCache.set(key, html);
    while (fragmentCache.size > MAX_FRAGMENT_CACHE_ENTRIES) fragmentCache.delete(fragmentCache.keys().next().value);
  };
  const initialMain = document.querySelector('main');
  if (initialMain) rememberFragment(fragmentKey(new URL(window.location.href)), initialMain.innerHTML);
  const loadFragment = async (target, key) => {
    const cached = fragmentCache.get(key);
    if (cached !== undefined) return cached;
    const pending = fragmentRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
      const response = await fetch(target.href, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('dashboard navigation failed');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const nextMain = page.querySelector('main');
      if (!nextMain) throw new Error('dashboard response has no main element');
      const fragment = nextMain.innerHTML;
      rememberFragment(key, fragment);
      return fragment;
    })();
    fragmentRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (fragmentRequests.get(key) === request) fragmentRequests.delete(key);
    }
  };
  const prefetchDashboard = (target) => {
    if (target.origin !== window.location.origin || target.pathname !== '/command-center') return;
    const key = fragmentKey(target);
    if (fragmentCache.has(key) || fragmentRequests.has(key)) return;
    void loadFragment(target, key).catch(() => {});
  };
  const shouldPrefetch = (link) => link.matches('.period-quick-link, .period-menu a, .period-nav');
  document.addEventListener('pointerover', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!link || !shouldPrefetch(link) || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return;
    prefetchDashboard(new URL(link.href, window.location.href));
  });
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (link && shouldPrefetch(link)) prefetchDashboard(new URL(link.href, window.location.href));
  });
  let navigationSerial = 0;
  const navigateDashboard = async (target, replace = false) => {
    const main = document.querySelector('main');
    if (!main) return;
    const serial = ++navigationSerial;
    const key = fragmentKey(target);
    main.classList.add('dashboard-loading');
    main.setAttribute('aria-busy', 'true');
    try {
      let fragment = fragmentCache.get(key);
      if (fragment === undefined) {
        fragment = await loadFragment(target, key);
      } else {
        rememberFragment(key, fragment);
      }
      if (serial !== navigationSerial) return;
      main.innerHTML = fragment;
      if (replace) history.replaceState({}, '', target.href);
      else history.pushState({}, '', target.href);
      applyTheme(themeOf());
      bindDashboardInteractions(main);
      window.scrollTo(0, 0);
    } catch {
      if (serial === navigationSerial) window.location.assign(target.href);
    } finally {
      if (serial === navigationSerial) {
        main.classList.remove('dashboard-loading');
        main.removeAttribute('aria-busy');
      }
    }
  };
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    const target = new URL(link.href, window.location.href);
    if (target.origin !== window.location.origin || target.pathname !== '/command-center') return;
    event.preventDefault();
    void navigateDashboard(target);
  });
  window.addEventListener('popstate', () => void navigateDashboard(new URL(window.location.href), true));
  let dashboardFingerprint = '';
  let fingerprintRequest = null;
  const checkDashboardFingerprint = async () => {
    if (fingerprintRequest) return fingerprintRequest;
    fingerprintRequest = (async () => {
      try {
        const response = await fetch('/api/command-center/fingerprint', { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json();
        const fingerprint = JSON.stringify([
          payload.pipelineUpdatedAt,
          payload.latestJobUpdatedAt,
          payload.latestEventAt,
          payload.videoRevision,
        ]);
        const editingForm = document.activeElement instanceof Element && document.activeElement.closest('form');
        if (editingForm) return;
        if (dashboardFingerprint && fingerprint !== dashboardFingerprint) {
          fragmentCache.clear();
          void navigateDashboard(new URL(window.location.href), true);
        }
        dashboardFingerprint = fingerprint;
      } catch { /* the current screen remains usable while the worker restarts */ }
    })().finally(() => {
      fingerprintRequest = null;
    });
    return fingerprintRequest;
  };
  void checkDashboardFingerprint();
  window.setInterval(() => void checkDashboardFingerprint(), 60000);
</script>
</body>
</html>`;
}
