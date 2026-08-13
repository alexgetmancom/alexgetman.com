import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("production nginx topology", () => {
  it("keeps the client address trusted across the stream, TLS and HTTP hops", () => {
    const stream = read("deploy/nginx/production/shared443.conf");
    const tls = read("deploy/nginx/production/alexgetman.com-ssl.conf");
    const http = read("deploy/nginx/production/alexgetman.com.conf");
    const headers = read("deploy/nginx/production/alexgetman-proxy-headers.conf");

    expect(stream).toContain("proxy_protocol on;");
    expect(tls.match(/listen 127\.0\.0\.1:4443 ssl proxy_protocol;/g)).toHaveLength(2);
    expect(tls.match(/real_ip_header proxy_protocol;/g)).toHaveLength(3);
    expect(tls).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(http).toContain("listen 127.0.0.1:81;");
    expect(headers).toContain("proxy_set_header X-Real-IP $http_x_real_ip;");
    expect(headers).toContain("proxy_set_header X-Forwarded-For $http_x_forwarded_for;");
  });

  it("keeps the proxy free of anything the application decides", () => {
    // Cache lifetimes, retired URLs, the Markdown twin, the Link header and the
    // noindex on operator surfaces are properties of the product, so they ship
    // in the image and reach self-hosted installs. Restating any of them here
    // creates a second place to change them, and the two drift apart silently.
    const http = read("deploy/nginx/production/alexgetman.com.conf");

    for (const leaked of ["Cache-Control", "X-Robots-Tag", "try_files", "root ", "text/markdown", "rel=", "return 410"]) {
      expect(http).not.toContain(leaked);
    }
  });

  it("keeps the second account's port mapping and its trusted-IP header agreeing", () => {
    // Both accounts share one host. Maru is reachable only through the proxy on
    // 8789, and it must read the client address from the header nginx actually
    // sets above — a mismatch here silently rate-limits every visitor as one IP.
    const maru = read("deploy/maru.compose.yaml");
    const maruNginx = read("deploy/nginx/production/marux.ru.conf");

    // The second Studio is reached on its own domain, and the URL it hands a
    // publishing platform must point there too. A default would let a lost host
    // env file publish media under the first Studio's domain, and the request
    // that reveals it comes from Meta.
    expect(maru).toContain("PUBLIC_BASE_URL: ${MARU_PUBLIC_BASE_URL:?");
    expect(read("deploy/nginx/production/alexgetman.com.conf")).not.toContain("8789");
    expect(maruNginx).toContain("location ^~ /media/video/asset/");
    expect(maru).toContain('"127.0.0.1:8789:8788"');
    expect(maru).toContain("TRUSTED_CLIENT_IP_HEADER: x-real-ip");
    expect(maruNginx).toContain("location = /healthz");
    expect(maruNginx).toContain("location = /readyz");
    expect(maruNginx.match(/proxy_pass http:\/\/127\.0\.0\.1:8789;/g)).toHaveLength(8);
  });

  it("keeps both accounts on one authentication story and one release path", () => {
    // Two Studios, one system: the dashboard is reached with the application's
    // token on both, and neither compose file may drift out of the release the
    // workflow ships. A rename that misses the workflow deploys nothing and
    // says nothing.
    const workflow = read(".github/workflows/check.yml");

    expect(read("deploy/nginx/production/alexgetman.com.conf")).not.toContain("auth_basic");
    expect(read("deploy/nginx/production/marux.ru.conf")).not.toContain("auth_basic");
    for (const compose of ["deploy/alex.compose.yaml", "deploy/maru.compose.yaml"]) {
      expect(read(compose)).toContain("container_name:");
      expect(workflow).toContain(compose);
    }
  });

  it("exposes the Studio transport the second account is operated through", () => {
    // Maru's agent runs on her own machine and reaches this Studio over MCP
    // alone. The default of this server block is `return 404`, so a route that
    // is not named here is not merely unauthorized — it does not exist.
    const maruNginx = read("deploy/nginx/production/marux.ru.conf");

    expect(maruNginx).toContain("location = /api/mcp");
    expect(maruNginx).toContain("location = /api/studio/media");
    expect(maruNginx).toContain("proxy_request_buffering off;");
  });
});
