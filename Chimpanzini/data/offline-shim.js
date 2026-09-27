(function () {
    "use strict";

    var CACHE_KEY = "__EJS_OFFLINE_CACHE__";
    if (!window[CACHE_KEY]) window[CACHE_KEY] = {};

    var pendingLoads = {};
    
    function resolveRelPath(urlStr) {
        var u;
        try {
            u = new URL(urlStr, document.baseURI);
        } catch (e) {
            return null;
        }
        if (u.protocol !== "file:") return null;

        var path = decodeURIComponent(u.pathname);
        var marker = "/data/";
        var idx = path.lastIndexOf(marker);
        if (idx === -1) return null;

        return path.slice(idx + marker.length);
    }
    window.__EJS_offlineResolveRelPath = resolveRelPath;

    function cacheScriptUrlFor(relPath) {
        return new URL("data-cache/" + relPath + ".js", document.baseURI).href;
    }

    function loadCacheScript(relPath) {
        if (pendingLoads[relPath]) return pendingLoads[relPath];

        pendingLoads[relPath] = new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = cacheScriptUrlFor(relPath);
            s.onload = function () {
                resolve();
            };
            s.onerror = function () {
                reject(
                    new Error(
                        "No offline cache entry for '" +
                            relPath +
                            "'. Run prepare-offline-cache.html once (from this project's " +
                            "root folder) and try again."
                    )
                );
            };
            document.head.appendChild(s);
        });

        return pendingLoads[relPath];
    }

    function base64ToBytes(b64) {
        var binary = atob(b64);
        var len = binary.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function guessMime(relPath) {
        if (relPath.endsWith(".json")) return "application/json";
        if (relPath.endsWith(".js")) return "text/javascript";
        if (relPath.endsWith(".css")) return "text/css";
        if (relPath.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    async function ensureAsset(relPath) {
        var store = window[CACHE_KEY];
        if (Object.prototype.hasOwnProperty.call(store, relPath)) {
            return store[relPath];
        }
        await loadCacheScript(relPath);
        if (!Object.prototype.hasOwnProperty.call(store, relPath)) {
            throw new Error(
                "Offline cache script loaded but did not contain '" + relPath + "'."
            );
        }
        return store[relPath];
    }

    // ---------------------------------------------------------------
    // Patch fetch() so file:// requests under data/ are served locally
    // ---------------------------------------------------------------
    var originalFetch = window.fetch.bind(window);

    window.fetch = async function (input, init) {
        var urlStr = typeof input === "string" ? input : input && input.url;
        var method =
            (init && init.method) || (input && input.method) || "GET";

        var relPath = resolveRelPath(urlStr);

        if (relPath === null) {
            // Not a local data/ file:// request (https://, blob:, data:, or
            // a local file outside data/) - leave it completely alone.
            return originalFetch(input, init);
        }

        if (String(method).toUpperCase() === "HEAD") {
            return new Response(null, { status: 200, statusText: "OK" });
        }

        try {
            var b64 = await ensureAsset(relPath);
            var bytes = base64ToBytes(b64);
            return new Response(bytes.buffer, {
                status: 200,
                statusText: "OK",
                headers: {
                    "Content-Type": guessMime(relPath),
                    "Content-Length": String(bytes.length)
                }
            });
        } catch (err) {
            console.error("[offline-shim] Failed to serve", relPath, err);
            return new Response(null, { status: 404, statusText: "Not Found" });
        }
    };

    // ---------------------------------------------------------------
    // Generic helper: read a local asset back out as decoded text.
    // Used for both CSS (injected as <style>) and JS modules (below).
    // ---------------------------------------------------------------
    window.__EJS_loadLocalText = async function (relPath) {
        var b64 = await ensureAsset(relPath);
        var bytes = base64ToBytes(b64);
        return new TextDecoder("utf-8").decode(bytes);
    };

    // ---------------------------------------------------------------
    // Helper for loader.js: load a local module without import()'ing
    // a file:// URL directly (which browsers refuse).
    // ---------------------------------------------------------------
    window.__EJS_loadLocalModule = async function (relPath) {
        var text = await window.__EJS_loadLocalText(relPath);

        // Strip any sourcemap comment - the .map file isn't reachable
        // from a Blob URL, so leaving this in just causes a harmless
        // 404 in devtools. Not needed for the app to run.
        text = text.replace(/\/\/#\s*sourceMappingURL=.*$/m, "");

        var blob = new Blob([text], { type: "text/javascript" });
        var blobUrl = URL.createObjectURL(blob);
        try {
            return await import(blobUrl);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    };
})();
