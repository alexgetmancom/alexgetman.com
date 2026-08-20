import { sendPageview } from "./pageview";

(() => {
  sendPageview({ path: window.location.pathname || "/" });
})();
