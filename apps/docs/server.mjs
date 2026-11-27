import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, "dist/client");
const serverEntryPath = path.resolve(__dirname, "dist/server/server.js");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "3000");
const apiTarget = (process.env.SCACE_API_URL || "http://127.0.0.1:3001").replace(
  /\/+$/,
  "",
);

const serverEntry = await import(serverEntryPath);
const ssrHandler = serverEntry.default;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isProxiedApiPath(pathname) {
  return (
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/api/auth" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  );
}

function readNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function sendWebResponse(res, webResponse) {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });

  if (!webResponse.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(webResponse.body);
  await new Promise((resolve, reject) => {
    nodeStream.on("error", reject);
    res.on("finish", resolve);
    nodeStream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || "GET";
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;

    if (pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ status: "ok", service: "@scace/docs" }));
      return;
    }

    if (isProxiedApiPath(pathname)) {
      const targetUrl = `${apiTarget}${reqUrl.pathname}${reqUrl.search}`;
      const forwardHeaders = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key.toLowerCase() === "host" || key.toLowerCase() === "connection") {
          continue;
        }
        forwardHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      }

      const body =
        method !== "GET" && method !== "HEAD"
          ? await readNodeRequestBody(req)
          : undefined;

      const upstream = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body,
        redirect: "manual",
      });
      await sendWebResponse(res, upstream);
      return;
    }

    if (method === "GET" || method === "HEAD") {
      const cleanPath = decodeURIComponent(pathname).replace(/^\/+/, "");
      if (cleanPath.length > 0) {
        const candidate = path.resolve(clientDir, cleanPath);
        if (
          candidate.startsWith(clientDir + path.sep) &&
          existsSync(candidate) &&
          statSync(candidate).isFile()
        ) {
          const ext = path.extname(candidate).toLowerCase();
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            MIME_TYPES[ext] || "application/octet-stream",
          );
          if (pathname.startsWith("/assets/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
          if (method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(candidate).pipe(res);
          return;
        }
      }
    }

    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      requestHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const body =
      method !== "GET" && method !== "HEAD"
        ? await readNodeRequestBody(req)
        : undefined;

    const webRequest = new Request(reqUrl.toString(), {
      method,
      headers: requestHeaders,
      body,
    });

    const webResponse = await ssrHandler.fetch(webRequest);
    await sendWebResponse(res, webResponse);
  } catch (err) {
    console.error("[scace-docs] Request error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Docs server failed to process request." }));
    } else {
      res.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`[scace-docs] Listening on http://${host}:${port} (API proxy: ${apiTarget})`);
});
