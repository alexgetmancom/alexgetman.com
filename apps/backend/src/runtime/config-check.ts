import { loadConfig } from "../foundation/config.js";

loadConfig(Bun.env);
console.log(JSON.stringify({ ok: true }));
