import { TARGETS } from "../../botTargets.js";

const ORDERED_IDS = [
  "site_en",
  "site_ru",
  "threads_en",
  "threads_ru",
  "facebook",
  "facebook_ru",
  "instagram_stories",
  "instagram_stories_ru",
  "telegram",
  "linkedin",
  "x",
  "telegram_stories",
  "bluesky",
  "mastodon",
  "devto",
  "github_en",
  "github_ru",
] as const;

type TargetInfo = { id: string; label: string; locale: string; kind: string };

export const ORDERED_TARGETS: TargetInfo[] = ORDERED_IDS.map((id) => {
  const found = TARGETS.find((target) => target[0] === id);
  return found ? { id: found[0] as string, label: found[1] as string, locale: found[2] as string, kind: found[3] as string } : null;
}).filter((target) => target !== null) as TargetInfo[];

export const PLATFORM_ICONS: Record<string, string> = {
  site: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  threads: `<svg viewBox="0 0 192 192" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M141.537 88.9883C140.71 88.5919 139.87 88.2104 139.019 87.8451C137.537 60.5382 122.616 44.905 97.5619 44.745C97.4484 44.7443 97.3355 44.7443 97.222 44.7443C82.2364 44.7443 69.7731 51.1409 62.102 62.7807L75.881 72.2328C81.6116 63.5383 90.6052 61.6848 97.2286 61.6848C97.3051 61.6848 97.3819 61.6848 97.4576 61.6855C105.707 61.7381 111.932 64.1366 115.961 68.814C118.893 72.2193 120.854 76.925 121.825 82.8638C114.511 81.6207 106.601 81.2385 98.145 81.7233C74.3247 83.0954 59.0111 96.9879 60.0396 116.292C60.5615 126.084 65.4397 134.508 73.775 140.011C80.8224 144.663 89.899 146.938 99.3323 146.423C111.79 146.423 121.563 140.987 128.381 132.296C133.559 125.696 136.834 117.143 138.28 106.366C144.217 109.949 148.617 114.664 151.047 120.332C155.179 129.967 155.42 145.8 142.501 158.708C131.182 170.016 117.576 174.908 97.0135 175.059C74.2042 174.89 56.9538 167.575 45.7381 153.317C35.2355 139.966 29.8077 120.682 29.6052 96C29.8077 71.3178 35.2355 52.0336 45.7381 38.6827C56.9538 24.4249 74.2039 17.11 97.0132 16.9405C119.988 17.1113 137.539 24.4614 149.184 38.788C154.894 45.8136 159.199 54.6488 162.037 64.9503L178.184 60.6422C174.744 47.9622 169.331 37.0357 161.965 27.974C147.036 9.60668 125.202 0.195148 97.0695 0H96.9569C68.8816 0.19447 47.2921 9.6418 32.7883 28.0793C19.8819 44.4864 13.2244 67.3157 13.0007 95.9325L13 96L13.0007 96.0675C13.2244 124.684 19.8819 147.514 32.7883 163.921C47.2921 182.358 68.8816 191.806 96.9569 192H97.0695C122.03 191.827 139.624 185.292 154.118 170.811C173.081 151.866 172.51 128.119 166.26 113.541C161.776 103.087 153.227 94.5962 141.537 88.9883ZM98.4405 129.507C88.0005 130.095 77.1544 125.409 76.6196 115.372C76.2232 107.93 81.9158 99.626 99.0812 98.6368C101.047 98.5234 102.976 98.468 104.871 98.468C111.106 98.468 116.939 99.0737 122.242 100.233C120.264 124.935 108.662 128.946 98.4405 129.507Z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c4.56-.93 8-4.96 8-9.75z"></path></svg>`,
  telegram: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.53-1.39.51-.46-.01-1.35-.26-2.01-.48-.8-.27-1.44-.42-1.39-.89.03-.25.38-.51 1.06-.78 4.15-1.81 6.91-3 8.28-3.57 3.94-1.63 4.76-1.91 5.3-.13z"></path></svg>`,
  telegram_stories: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 2 14.9 8.3 22 9.1l-5.3 4.7 1.5 6.9L12 17.2 5.8 20.7l1.5-6.9L2 9.1l7.1-.8L12 2Z"></path></svg>`,
  instagram: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"></circle></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"></path></svg>`,
  x: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>`,
  bluesky: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 12.7c-1.1-2.1-4.1-6-6.9-7.9C2.4 3 .7 3.3.2 4.2-.3 5.1.1 8.8.5 9.9c.8 2.7 3.7 3.6 6.3 3.2-4.5.7-8.5 2.5-3.2 8.4 5.9 6.1 8.1-1.3 8.4-5.1.3 3.8 2.5 11.2 8.4 5.1 5.3-5.9 1.3-7.7-3.2-8.4 2.6.4 5.5-.5 6.3-3.2.4-1.1.8-4.8.3-5.7-.5-.9-2.2-1.2-4.9.6-2.8 1.9-5.8 5.8-6.9 7.9Z"/></svg>`,
  mastodon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M20.9 8.1c0-4.2-2.8-5.4-2.8-5.4C16.7 2 14.3 2 12 2h-.1c-2.3 0-4.7 0-6.1.7 0 0-2.8 1.2-2.8 5.4 0 1 0 2.2.1 3.4.4 4.1 3 5.1 5.7 5.5 1.4.2 2.6.2 3.2.2 1.1-.1 1.8-.3 1.8-.3l-.1-1.9s-.8.3-1.7.4c-1.7.1-3.4-.2-3.7-2.1h8.4c.1 0 2.6-.1 3-3 .1-.6.2-1.3.2-2.2Zm-3.6 2.4h-2.4V7.7c0-.6-.3-1-1-1s-1.1.4-1.1 1v2.8h-2.4V7.7c0-.6-.3-1-1-1s-1.1.4-1.1 1v2.8H5.9V7.6c0-2.2 1.4-3.4 3-3.4 1 0 1.8.4 2.3 1.1L12 6l.8-.7c.5-.7 1.3-1.1 2.3-1.1 1.6 0 3 1.2 3 3.4v2.9Z"/></svg>`,
  devto: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M7.8 7.5c-.3-.3-.7-.5-1.2-.5H4v10h2.6c.5 0 .9-.2 1.2-.5.3-.3.5-.8.5-1.3V8.8c0-.5-.2-1-.5-1.3ZM6.5 15H5.8V9h.7v6Zm6.7-6V7h-4v10h4v-2h-2.2v-2h1.7v-2h-1.7V9h2.2Zm4.7 8 2.1-10h-1.9l-1.1 6.2L15.9 7H14l2.1 10h1.8Z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align: middle;"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.2.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 .1.8 2.1 3.4 1.5.1-.8.4-1.4.7-1.7-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2A11.5 11.5 0 0 1 12 6.8c1 0 2 .1 2.9.4 2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.3.8 1 .8 2v3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>`,
};

export const TOOL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;

export function platformKey(targetId: string): string {
  if (targetId.startsWith("site_")) return "site";
  if (targetId.startsWith("threads_")) return "threads";
  if (targetId.startsWith("facebook")) return "facebook";
  if (targetId.startsWith("instagram_stories")) return "instagram";
  if (targetId === "telegram_stories") return "telegram_stories";
  if (targetId.startsWith("github_")) return "github";
  return targetId;
}
