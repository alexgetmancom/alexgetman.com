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

// Expandable Social Bar & Theme Toggle Logic
document.addEventListener("DOMContentLoaded", () => {
  // Navigation Drawer Toggle Logic
  const burgerButtons = [document.getElementById("burger-toggle-btn"), document.getElementById("immersive-burger-btn")].filter(
    (button): button is HTMLElement => button != null,
  );
  const navCloseBtn = document.getElementById("nav-close-btn");
  const navOverlay = document.getElementById("nav-overlay");
  const navDrawer = document.getElementById("nav-drawer");

  function openDrawer() {
    if (navDrawer && navOverlay) {
      navDrawer.classList.add("active");
      navOverlay.classList.add("active");
    }
  }

  function closeDrawer() {
    if (navDrawer && navOverlay) {
      navDrawer.classList.remove("active");
      navOverlay.classList.remove("active");
    }
  }

  burgerButtons.forEach((button) => {
    button.addEventListener("click", openDrawer);
  });

  if (navCloseBtn) {
    navCloseBtn.addEventListener("click", closeDrawer);
  }

  if (navOverlay) {
    navOverlay.addEventListener("click", closeDrawer);
  }

  // Close drawer on escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
    }
  });

  // Close drawer on link selection
  const drawerLinks = document.querySelectorAll(".nav-drawer__link");
  drawerLinks.forEach((link) => {
    link.addEventListener("click", () => {
      closeDrawer();
    });
  });
  // Theme Toggle Logic
  const themeToggleButtons = document.querySelectorAll(".theme-toggle");
  themeToggleButtons.forEach((themeToggleBtn) => {
    themeToggleBtn.addEventListener("click", () => {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const newTheme = currentTheme === "light" ? "dark" : "light";

      if (newTheme === "light") {
        document.documentElement.setAttribute("data-theme", "light");
        localStorage.setItem("theme", "light");
      } else {
        document.documentElement.setAttribute("data-theme", "dark");
        localStorage.setItem("theme", "dark");
      }
    });
  });

  // Language Toggle Logic
  const langToggleBtn = document.getElementById("lang-toggle-btn");
  if (langToggleBtn) {
    langToggleBtn.addEventListener("click", () => {
      const currentLang = (document.documentElement.getAttribute("lang") || "ru").toLowerCase();
      window.location.href = currentLang.startsWith("ru") ? "/" : "/ru/";
    });
  }
});
