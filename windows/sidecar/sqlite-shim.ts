import { createRequire } from "node:module";

// The packaged Windows sidecar stores native packages under `vendor/` because
// electron-builder intentionally filters nested node_modules from extra files.
// createRequire keeps the addon resolution relative to cli.mjs at runtime.
const load = createRequire(import.meta.url);
const Database = load("./vendor/better-sqlite3-multiple-ciphers") as typeof import("better-sqlite3-multiple-ciphers").default;

export default Database;
