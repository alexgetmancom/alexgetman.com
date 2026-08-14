import { describe, expect, it } from "bun:test";
import { type Command, type CommandResult, type DeployInputs, deployRelease } from "../../../scripts/deploy-release.js";

const inputs: DeployInputs = {
  host: "host.example",
  user: "deploy",
  agentToken: "t".repeat(16),
  image: "ghcr.io/alexgetmancom/solo-publisher@sha256:" + "a".repeat(64),
  mediaProcessorImage: "ghcr.io/alexgetmancom/alexgetman-media-processor@sha256:" + "b".repeat(64),
  release: "abc1234",
  deployAgentChanged: false,
  caddyConfigChanged: false,
  maruDeployEnabled: false,
  publicReadyUrl: "https://studio.example/readyz",
  controlPath: "/tmp/deploy-ssh-%C",
};

function recorder(fail?: (script: string) => boolean) {
  const commands: Command[] = [];
  const run = async (command: Command): Promise<CommandResult> => {
    commands.push(command);
    const script = command.argv.join(" ");
    return { code: fail?.(script) ? 1 : 0, stdout: new Uint8Array() };
  };
  return { commands, run, scripts: () => commands.map((command) => command.argv.join(" ")) };
}

describe("production deployment", () => {
  it("ships the Studio configuration on every deployment", async () => {
    // Copying only when a diff named these files lost the change for good when
    // a run failed after the commit that made it, and the site went on serving
    // a configuration the repository had moved past.
    const { run, scripts } = recorder();
    await deployRelease(inputs, run, () => {});

    const archive = scripts().find((script) => script.startsWith("tar -cf -"));
    for (const file of ["deploy/alex.compose.yaml", "deploy/maru.compose.yaml", "studio.alex.yaml", "studio.maru.yaml"])
      expect(archive).toContain(file);
    expect(scripts().some((script) => script.includes("cp '/home/deploy/alexgetman-runtime/release-files/abc1234/studio.alex.yaml'"))).toBe(
      true,
    );
  });

  it("activates only after the configuration is in place, and verifies only after that", async () => {
    // The order is the whole safety property: a container recreated before its
    // configuration arrives runs the previous one, and a reconciliation that
    // runs before activation describes the release that came before.
    const { run, scripts } = recorder();
    await deployRelease(inputs, run, () => {});

    const at = (needle: string) => scripts().findIndex((script) => script.includes(needle));
    expect(at("studio.yaml.next")).toBeLessThan(at("/v1/deploy"));
    expect(at("/v1/deploy")).toBeLessThan(at("readyz"));
    expect(at("readyz")).toBeLessThan(at("deploy-image.env.next"));
    expect(at("deploy-image.env.next")).toBeLessThan(at("rm -rf"));
  });

  it("leaves the proxy and the agent alone unless they changed", async () => {
    const untouched = recorder();
    await deployRelease(inputs, untouched.run, () => {});
    expect(untouched.scripts().some((script) => script.includes("caddy reload"))).toBe(false);
    expect(untouched.scripts().some((script) => script.includes("systemctl restart"))).toBe(false);

    const changed = recorder();
    await deployRelease({ ...inputs, caddyConfigChanged: true, deployAgentChanged: true }, changed.run, () => {});
    expect(changed.scripts().some((script) => script.includes("caddy validate"))).toBe(true);
    expect(changed.scripts().some((script) => script.includes("caddy reload"))).toBe(true);
    expect(changed.scripts().some((script) => script.includes("systemctl restart alexgetman-deploy-agent"))).toBe(true);
  });

  it("stops when a Studio does not come back", async () => {
    // Readiness failing has to end the deployment, not be reported and passed:
    // the reconciliation after it would otherwise record a release nobody
    // proved was serving.
    const { run, scripts } = recorder((script) => script.includes("readyz"));
    await expect(deployRelease(inputs, run, () => {})).rejects.toThrow("did not become ready");
    expect(scripts().some((script) => script.includes("deploy-image.env.next"))).toBe(false);
  });

  it("stops when the host refuses a step instead of carrying on", async () => {
    const { run } = recorder((script) => script.includes("/v1/deploy"));
    await expect(deployRelease(inputs, run, () => {})).rejects.toThrow("remote command failed");
  });

  it("names what it cannot proceed without", async () => {
    const { run } = recorder();
    await expect(deployRelease({ ...inputs, image: "" }, run, () => {})).rejects.toThrow("IMAGE is required");
    await expect(deployRelease({ ...inputs, host: "" }, run, () => {})).rejects.toThrow("DEPLOY_HOST is required");
  });
});
