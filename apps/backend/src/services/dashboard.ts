import type { ReturnTypeOfCommandCenter } from "./commandCenter.js";

const TABS = ["pipeline", "queue", "credentials", "diagnostics", "repair"] as const;
type DashboardTab = (typeof TABS)[number];

export function renderDashboard(payload: ReturnTypeOfCommandCenter, requestedTab: string | undefined): string {
  const tab: DashboardTab = TABS.includes(requestedTab as DashboardTab) ? requestedTab as DashboardTab : "pipeline";
  const tabs = TABS.map((item) => `<a href="/command-center?tab=${item}" class="${item === tab ? "active" : ""}">${label(item)}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Command Center</title><style>${styles()}</style></head>
  <body><header><div><strong>Command Center</strong><span>${escapeHtml(payload.generatedAt)}</span></div><nav>${tabs}</nav></header>
  <main>${section(tab, payload)}</main><script>${chartScript()}</script></body></html>`;
}

function section(tab: DashboardTab, data: ReturnTypeOfCommandCenter): string {
  if (tab === "pipeline") return `<section><div class="summary"><b class="${data.pipeline.ok ? "ok" : "bad"}">${data.pipeline.ok ? "Operational" : "Attention"}</b><span>revision ${escapeHtml(data.pipeline.gitRevision || "unknown")}</span><span>${data.pipeline.feed.items} feed items</span></div>${weeklyChart(data.pipeline.posts)}${table(["Post", "Date", "RU", "EN", "Targets"], data.pipeline.posts.map((post) => [post.post_id ?? post.message_id, post.date ?? post.created_at, short(post.text_ru), short(post.text_en), targetSummary(post.targets)]))}</section>`;
  if (tab === "queue") return `<section><h1>Queue</h1>${table(["Job", "Post", "Target", "Status", "Attempts", "Error"], data.jobs.map((job) => [job.job_id, job.post_key, job.target, job.status, job.attempt_count, short(job.last_error)]))}</section>`;
  if (tab === "credentials") return `<section><h1>Credentials</h1>${table(["Credential", "Status", "Checked", "Details"], data.credentials.map((item) => [item.name ?? item.credential ?? item.target, item.status ?? (item.ok ? "ok" : "failed"), item.checked_at ?? item.updated_at, short(item.details_json ?? item.error)]))}</section>`;
  if (tab === "diagnostics") return `<section><h1>Diagnostics</h1><h2>Workers</h2>${table(["Worker", "OK", "Last run", "Error"], data.pipeline.workers.map((worker) => [worker.name, worker.ok, worker.lastRunAt, worker.lastError]))}<h2>Events</h2>${table(["Time", "Severity", "Post", "Target", "Message"], data.events.map((event) => [event.createdAt, event.severity, event.postKey, event.target, event.message]))}<h2>Lifecycle</h2>${table(["Post", "State", "Updated", "Details"], data.lifecycle.map((item) => [item.post_key ?? item.post_id, item.state ?? item.status, item.updated_at, short(item.details_json)]))}</section>`;
  return `<section><h1>Repair</h1><form method="post" action="/api/command-center/action"><label>Publication ref<input name="ref" placeholder="post:52" required></label><label>Target<input name="target" placeholder="threads_en"></label><div class="commands"><button name="action" value="retry">Retry latest</button><button name="action" value="republish">Republish</button></div></form><h2>Drafts</h2>${table(["Draft", "Status", "RU", "EN", "Updated"], data.drafts.map((draft) => [draft.id, draft.status, short(draft.text_ru), short(draft.text_en_approved ?? draft.text_en_machine), draft.updated_at]))}<h2>Actions</h2>${table(["Time", "Action", "Target", "Status"], data.actions.map((item) => [item.created_at, item.action, item.target, item.status]))}</section>`;
}

function weeklyChart(posts: Array<Record<string, unknown>>): string {
  const days = new Map<string, number>();
  for (const post of posts) {
    const day = String(post.date ?? post.created_at ?? "").slice(0, 10);
    if (!day) continue;
    let value = 0;
    const metrics = post.metrics && typeof post.metrics === "object" ? post.metrics as Record<string, unknown> : {};
    for (const target of Object.values(metrics)) if (target && typeof target === "object") for (const [name, metric] of Object.entries(target as Record<string, unknown>)) {
      if (name === "views" && metric && typeof metric === "object") value += Number((metric as Record<string, unknown>).value ?? 0);
    }
    days.set(day, (days.get(day) ?? 0) + value);
  }
  const values = [...days.entries()].sort().slice(-7);
  if (values.length === 0) return "";
  const width = 980, height = 150, max = Math.max(...values.map(([, value]) => value), 1);
  const points = values.map(([, value], index) => `${40 + index * (900 / Math.max(values.length - 1, 1))},${120 - value * 95 / max}`).join(" ");
  const labels = values.map(([day], index) => `<text x="${40 + index * (900 / Math.max(values.length - 1, 1))}" y="143" text-anchor="middle">${day.slice(5)}</text>`).join("");
  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly views"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3"/>${labels}</svg></div>`;
}

function table(headers: string[], rows: unknown[][]): string {
  return `<div class="table"><table><thead><tr>${headers.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value ?? "-")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function label(tab: DashboardTab): string { return ({ pipeline: "Publications", queue: "Queue", credentials: "Credentials", diagnostics: "Diagnostics", repair: "Repair" })[tab]; }
function short(value: unknown): string { const text = String(value ?? "").replace(/\s+/g, " "); return text.length > 100 ? `${text.slice(0, 97)}...` : text; }
function targetSummary(value: unknown): string { if (!value || typeof value !== "object") return "-"; return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}:${typeof item === "object" && item ? (item as Record<string, unknown>).status : item}`).join(" · "); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function chartScript(): string { return `document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',async e=>{e.preventDefault();const r=await fetch(f.action,{method:'POST',body:new FormData(f)});const j=await r.json();alert(r.ok?'Action queued':(j.detail||'Failed'));if(r.ok)location.reload()}));`; }
function styles(): string { return `:root{font-family:Inter,system-ui,sans-serif;color:#171717;background:#f5f6f8;letter-spacing:0}*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #ddd;padding:14px 24px;position:sticky;top:0}header>div{display:flex;gap:16px;align-items:baseline}header span{color:#666;font-size:12px}nav{display:flex;gap:4px;margin-top:14px;overflow:auto}nav a{color:#444;text-decoration:none;padding:8px 10px;border-bottom:2px solid transparent;white-space:nowrap}nav a.active{color:#000;border-color:#000}main{padding:24px;max-width:1600px;margin:auto}section{width:100%}h1{font-size:20px}h2{font-size:15px;margin-top:28px}.summary{display:flex;gap:18px;align-items:center;margin-bottom:18px}.ok{color:#087443}.bad{color:#b42318}.table{overflow:auto;background:#fff;border:1px solid #ddd;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top}th{background:#fafafa;position:sticky;top:0}.chart{background:#fff;border:1px solid #ddd;border-radius:6px;margin-bottom:16px;padding:8px;color:#1769aa}.chart svg{display:block;width:100%;height:150px}.chart text{font-size:10px;fill:#666}form{max-width:680px;display:grid;gap:12px;background:#fff;border:1px solid #ddd;border-radius:6px;padding:16px}label{display:grid;gap:5px;font-size:12px}input{padding:9px;border:1px solid #bbb;border-radius:4px}.commands{display:flex;gap:8px}button{padding:9px 12px;border:1px solid #111;background:#111;color:#fff;border-radius:4px}@media(max-width:700px){header,main{padding:14px}.summary{align-items:flex-start;flex-direction:column;gap:5px}}`; }
