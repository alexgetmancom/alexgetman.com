export {};

(() => {
  if (window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1")) {
    return;
  }
  const payload = JSON.stringify({ path: window.location.pathname || "/" });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/stats/pageview", new Blob([payload], { type: "application/json" }));
      return;
    }
    fetch("/stats/pageview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "omit",
      cache: "no-store",
    });
  } catch {}
})();
