export function sendPageview(event: Record<string, unknown>): void {
  if (window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1")) return;
  const body = JSON.stringify(event);
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/stats/pageview", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/stats/pageview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
      cache: "no-store",
    });
  } catch {}
}
