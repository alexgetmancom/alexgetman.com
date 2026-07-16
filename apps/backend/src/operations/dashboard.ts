import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import {
  renderAudienceSection,
  renderCredentialsSection,
  renderDiagnosticsSection,
  renderQueueSection,
  renderRepairSection,
} from "./dashboard/ops-sections.js";
import { renderPipelineSection } from "./dashboard/pipeline-section.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { operationsService } from "./service.js";

export function renderDashboard(config: BackendConfig, backendDb: BackendDb, weekOffset: number, ref = "", messageId = ""): string {
  const service = operationsService(backendDb, config);
  const ops = service.dashboard();
  const body = `
    <nav class="dashboard-tabs"><a href="#overview">Обзор</a><a href="#queue">Очередь</a><a href="#health">Health</a></nav>
    <section id="overview" class="overview">${renderAudienceSection(backendDb, config)}${renderPipelineSection(weekOffset, service.pipeline(weekOffset))}</section>
    <details id="queue"><summary>Queue и черновики</summary>${renderQueueSection(ops)}</details>
    <details id="health"><summary>Health: credentials и diagnostics</summary>${renderCredentialsSection(ops)}${renderDiagnosticsSection(ops)}</details>
    <details id="repair"><summary>Emergency repair</summary>${renderRepairSection(ref, messageId)}</details>`;
  return renderDashboardShell(body);
}

export function renderCommandCenterLogin(error = false): string {
  return renderDashboardShell(
    `<section class="command-login"><h1>Command Center</h1><p class="note">Введите Command Center token. Он сохранится в защищённой HttpOnly-cookie на 180 дней; при смене токена потребуется войти снова.</p>${error ? '<p class="login-error">Неверный token.</p>' : ""}<form method="post" action="/command-center"><input type="password" name="token" autocomplete="current-password" aria-label="Command Center token" placeholder="Command Center token" required><button type="submit">Open Command Center</button></form></section>`,
  );
}
