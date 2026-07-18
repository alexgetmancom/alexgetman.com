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
    const tls = read("deploy/nginx/production/ialexey.ru-ssl.conf");
    const http = read("deploy/nginx/production/ialexey.ru.conf");
    const headers = read("deploy/nginx/production/alexgetman-proxy-headers.conf");

    expect(stream).toContain("proxy_protocol on;");
    expect(tls.match(/listen 127\.0\.0\.1:4443 ssl proxy_protocol;/g)).toHaveLength(3);
    expect(tls.match(/real_ip_header proxy_protocol;/g)).toHaveLength(3);
    expect(tls).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(http).toContain("listen 127.0.0.1:81;");
    expect(headers).toContain("proxy_set_header X-Real-IP $http_x_real_ip;");
    expect(headers).toContain("proxy_set_header X-Forwarded-For $http_x_forwarded_for;");
  });

  it("keeps Maru media proxied and verifies both runtime services during deployment", () => {
    const http = read("deploy/nginx/production/ialexey.ru.conf");
    const maruHttp = read("deploy/nginx/production/marux.ru.conf");
    const maruTls = read("deploy/nginx/production/marux.ru-ssl.conf");
    const stream = read("deploy/nginx/production/shared443.conf");
    const maru = read("deploy/maru.compose.yaml");
    const workflow = read(".github/workflows/deploy.yml");

    expect(http).toContain("location ^~ /maru-media/");
    expect(http).toContain("proxy_pass http://127.0.0.1:8789/");
    expect(maru).toContain("TRUSTED_CLIENT_IP_HEADER: x-real-ip");
    expect(maru).toContain('"127.0.0.1:8789:8788"');
    expect(maru).toContain("host.docker.internal:host-gateway");
    expect(maru).toContain("healthcheck:");
    expect(workflow).toContain("/etc/nginx/stream-conf.d/shared443.conf");
    expect(workflow).toContain("/etc/nginx/sites-enabled/ialexey.ru-ssl");
    expect(workflow).toContain("/etc/nginx/sites-enabled/ialexey.ru");
    expect(workflow).toContain("sudo nginx -t; sudo systemctl reload nginx");
    expect(workflow).toContain("http://127.0.0.1:8789/readyz");
    expect(workflow).toContain("docker image prune --all --force");
    expect(workflow).toContain("docker builder prune --all --force");
    expect(stream).toContain("marux.ru marux_https;");
    expect(maruTls).toContain("/etc/letsencrypt/live/marux.ru/fullchain.pem");
    expect(maruHttp).toContain("location = /command-center");
    expect(maruHttp).toContain("location = /api/command-center");
    expect(maruHttp).toContain("location ^~ /media/video/asset/");
    expect(maruHttp).toContain("return 404;");
    expect(workflow).toContain("/etc/nginx/sites-enabled/marux.ru");
    expect(workflow).toContain("marux.ru-bootstrap");
  });
});
