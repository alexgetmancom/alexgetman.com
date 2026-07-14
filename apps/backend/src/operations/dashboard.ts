import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { renderCredentialsSection, renderDiagnosticsSection, renderQueueSection, renderRepairSection } from "./dashboard/ops-sections.js";
import { renderPipelineSection } from "./dashboard/pipeline-section.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { pipelineStatusPayload } from "./pipeline.js";
import { operationsService } from "./service.js";

export function renderDashboard(config: BackendConfig, backendDb: BackendDb, weekOffset: number, ref = "", messageId = ""): string {
  const ops = operationsService(backendDb, config).dashboard();
  const body = `
    <header class="dashboard-heading">
      <h1>Command Center</h1>
      <p class="note">Pipeline, очередь, состояние интеграций и аварийные действия в одном месте.</p>
    </header>
    <section id="pipeline"><h2>Pipeline</h2>${renderPipelineSection(weekOffset, pipelineStatusPayload(config, backendDb, weekOffset))}</section>
    <details id="queue"><summary>Queue и черновики</summary>${renderQueueSection(ops)}</details>
    <details id="health"><summary>Health: credentials и diagnostics</summary>${renderCredentialsSection(ops)}${renderDiagnosticsSection(ops)}</details>
    <details id="repair"><summary>Emergency repair</summary>${renderRepairSection(ref, messageId)}</details>
    <details id="json"><summary>JSON для агентов</summary><section><p><a href="/api/command-center">/api/command-center</a> — очередь, credentials, diagnostics и последние действия. <a href="/api/pipeline-status?week_offset=${weekOffset}">/api/pipeline-status</a> — неделя pipeline.</p><p class="note">Оба API требуют тот же Command Center token. Старый <code>/api/ops-dashboard</code> оставлен как совместимый alias.</p></section></details>`;
  return renderDashboardShell(body);
}

export function renderCommandCenterLogin(error = false): string {
  return renderDashboardShell(
    `<section class="command-login"><h1>Command Center</h1><p class="note">Введите Command Center token. Он сохранится в защищённой HttpOnly-cookie на 180 дней; при смене токена потребуется войти снова.</p>${error ? '<p class="login-error">Неверный token.</p>' : ""}<form method="post" action="/command-center"><input type="password" name="token" autocomplete="current-password" aria-label="Command Center token" placeholder="Command Center token" required><button type="submit">Open Command Center</button></form></section>`,
  );
}
