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
    expect(tls.match(/real_ip_header proxy_protocol;/g)).toHaveLength(2);
    expect(tls).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(http).toContain("listen 127.0.0.1:81;");
    expect(http).toContain("location = /feed.json");
    expect(http).toContain("location = /feed.xml");
    expect(headers).toContain("proxy_set_header X-Real-IP $http_x_real_ip;");
    expect(headers).toContain("proxy_set_header X-Forwarded-For $http_x_forwarded_for;");
  });

  it("keeps the second account's port mapping and its trusted-IP header agreeing", () => {
    // Both accounts share one host. Maru is reachable only through the proxy on
    // 8789, and it must read the client address from the header nginx actually
    // sets above — a mismatch here silently rate-limits every visitor as one IP.
    const http = read("deploy/nginx/production/alexgetman.com.conf");
    const maru = read("deploy/maru.compose.yaml");
    const maruNginx = read("deploy/nginx/production/marux.ru.conf");

    expect(http).toContain("proxy_pass http://127.0.0.1:8789/");
    expect(maru).toContain('"127.0.0.1:8789:8788"');
    expect(maru).toContain("TRUSTED_CLIENT_IP_HEADER: x-real-ip");
    expect(maruNginx).toContain("location = /healthz");
    expect(maruNginx).toContain("location = /readyz");
    expect(maruNginx.match(/proxy_pass http:\/\/127\.0\.0\.1:8789;/g)).toHaveLength(6);
  });
});
