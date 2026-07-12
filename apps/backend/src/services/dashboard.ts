import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { commandCenterPayload } from "./commandCenter.js";
import { renderCredentialsSection, renderDiagnosticsSection, renderQueueSection, renderRepairSection } from "./dashboard/ops-sections.js";
import { renderPipelineSection } from "./dashboard/pipeline-section.js";
import { renderDashboardShell } from "./dashboard/shell.js";
import { pipelineStatusPayload } from "./pipeline.js";

const TABS = ["pipeline", "repair", "queue", "credentials", "diagnostics"] as const;
type DashboardTab = (typeof TABS)[number];

export function renderDashboard(config: BackendConfig, backendDb: BackendDb, requestedTab: string | undefined, weekOffset: number): string {
  const tab: DashboardTab = TABS.includes(requestedTab as DashboardTab) ? (requestedTab as DashboardTab) : "pipeline";
  const ops = commandCenterPayload(config, backendDb);
  const body =
    tab === "repair"
      ? renderRepairSection("", "")
      : tab === "queue"
        ? renderQueueSection(ops)
        : tab === "credentials"
          ? renderCredentialsSection(ops)
          : tab === "diagnostics"
            ? renderDiagnosticsSection(ops)
            : renderPipelineSection(weekOffset, pipelineStatusPayload(config, backendDb, weekOffset));
  const navLinks = TABS.map((item) => {
    const label = { pipeline: "Pipeline", repair: "Repair", queue: "Queue", credentials: "Credentials", diagnostics: "Diagnostics" }[item];
    return `<a class="${item === tab ? "active" : ""}" href="/command-center?tab=${item}&week_offset=${weekOffset}">${label}</a>`;
  }).join("");
  return renderDashboardShell(body, navLinks);
}
