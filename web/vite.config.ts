import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

// 发版后浏览器无需强刷：仅对 HTML 响应设置 no-cache；哈希命名的静态资源由内容指纹保证新鲜，
// 且不影响 /canvas-api 代理响应（视频 blob 等大文件不受影响）。
function noCacheHtml(): Plugin {
    return {
        name: "no-cache-html",
        configurePreviewServer(server) {
            server.middlewares.use((_req, res, next) => {
                const original = res.setHeader.bind(res) as (name: string, value: unknown) => void;
                const patched = ((name: string, value: unknown) => {
                    original(name, value);
                    if (String(name).toLowerCase() === "content-type" && typeof value === "string" && value.includes("text/html")) original("Cache-Control", "no-cache");
                    return true;
                }) as unknown as typeof res.setHeader;
                res.setHeader = patched;
                next();
            });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), noCacheHtml()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    preview: { proxy: process.env.CANVAS_SAME_ORIGIN_PROXY === "1" ? {
        "/canvas-api": { target: "http://127.0.0.1:23210", rewrite: (path) => path.replace(/^\/canvas-api/, ""), timeout: 180000, proxyTimeout: 180000 },
        "/admin-api": { target: "http://127.0.0.1:23210", timeout: 30000, proxyTimeout: 30000 },
    } : {} },
    // Opt in only on the localhost server deployment; static hosting stays unchanged.
    server: { proxy: process.env.CANVAS_SAME_ORIGIN_PROXY === "1" ? {
        "/canvas-api": { target: "http://127.0.0.1:23210", rewrite: (path) => path.replace(/^\/canvas-api/, ""), timeout: 180000, proxyTimeout: 180000 },
        "/admin-api": { target: "http://127.0.0.1:23210", timeout: 30000, proxyTimeout: 30000 },
    } : {} },
    define: {
        "import.meta.env.VITE_CANVAS_SAME_ORIGIN_PROXY": JSON.stringify(process.env.CANVAS_SAME_ORIGIN_PROXY === "1" ? "1" : "0"),
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
