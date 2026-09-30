const express = require("express");
const http = require("http");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const PORT = Number(process.env.PORT || 3000);
const sessions = new Map();
const pendingSessions = new Set();
const MAX_SESSIONS = 3;
const SESSION_TTL = 10 * 60 * 1000;
const MAX_BODY = 1024 * 1024;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

function safeSend(ws, data) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] === 0
  );
}

function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  return x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80:");
}

async function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("URL tidak valid."); }

  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Hanya http:// dan https:// yang diizinkan.");
  }

  if (u.username || u.password) {
    throw new Error("URL dengan embedded credentials tidak diizinkan.");
  }

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    throw new Error("Host lokal/internal tidak diizinkan.");
  }

  if (net.isIP(host)) {
    if (net.isIP(host) === 4 && isPrivateIPv4(host)) throw new Error("IP private tidak diizinkan.");
    if (net.isIP(host) === 6 && isPrivateIPv6(host)) throw new Error("IP private tidak diizinkan.");
  } else {
    let records;
    try { records = await dns.lookup(host, { all: true }); }
    catch { throw new Error("Domain tidak dapat di-resolve."); }

    if (!records.length) throw new Error("Domain tidak dapat di-resolve.");
    for (const r of records) {
      if (net.isIP(r.address) === 4 && isPrivateIPv4(r.address)) {
        throw new Error("Domain mengarah ke IP private/lokal.");
      }
      if (net.isIP(r.address) === 6 && isPrivateIPv6(r.address)) {
        throw new Error("Domain mengarah ke IP private/lokal.");
      }
    }
  }

  return u.toString();
}

function trimBody(body) {
  if (body == null) return null;
  const s = String(body);
  return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "\n… [truncated]" : s;
}

function classifyRequest(req) {
  const url = req.url();
  const type = req.resourceType();
  const lower = url.toLowerCase();
  if (type === "document") return "document";
  if (type === "stylesheet") return "css";
  if (type === "script") return "js";
  if (type === "image") return "img";
  if (type === "font") return "font";
  if (type === "xhr" || type === "fetch" || /\/api\/|graphql|json/.test(lower)) return "fetch";
  return type || "other";
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { await s.context.close(); } catch {}
  try { await s.browser.close(); } catch {}
}

async function createSession(id, url, ws) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: false
  });

  const page = await context.newPage();

  const session = {
    id, browser, context, page, ws,
    createdAt: Date.now(),
    requests: new Map()
  };
  sessions.set(id, session);

  page.on("request", async req => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const item = {
      id,
      url: req.url(),
      method: req.method(),
      type: classifyRequest(req),
      resourceType: req.resourceType(),
      requestHeaders: req.headers(),
      postData: trimBody(req.postData()),
      start: Date.now(),
      status: null,
      statusText: "",
      responseHeaders: {},
      responseBody: null,
      size: null,
      duration: null,
      failed: false
    };
    session.requests.set(req, item);
    safeSend(ws, { event: "network", data: { ...item, phase: "request" } });
  });

  page.on("response", async response => {
    const req = response.request();
    const item = session.requests.get(req);
    if (!item) return;

    item.status = response.status();
    item.statusText = response.statusText();
    item.responseHeaders = response.headers();
    item.duration = Date.now() - item.start;

    try {
      const buffer = await response.body();
      item.size = buffer.length;
      const ct = (item.responseHeaders["content-type"] || "").toLowerCase();
      if (
        ct.includes("json") ||
        ct.includes("text/") ||
        ct.includes("javascript") ||
        ct.includes("xml") ||
        ct.includes("svg")
      ) {
        item.responseBody = trimBody(buffer.toString("utf8"));
      }
    } catch {}

    safeSend(ws, { event: "network", data: { ...item, phase: "response" } });
  });

  page.on("requestfailed", req => {
    const item = session.requests.get(req);
    if (!item) return;
    item.failed = true;
    item.duration = Date.now() - item.start;
    safeSend(ws, {
      event: "network",
      data: {
        ...item,
        phase: "failed",
        errorText: req.failure()?.errorText || "Request failed"
      }
    });
  });

  page.on("console", msg => {
    safeSend(ws, {
      event: "console",
      data: {
        type: msg.type(),
        text: msg.text(),
        location: msg.location()
      }
    });
  });

  page.on("pageerror", err => {
    safeSend(ws, {
      event: "console",
      data: { type: "error", text: err.message, location: {} }
    });
  });

  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) {
      safeSend(ws, { event: "navigation", data: { url: frame.url() } });
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(err => {
    safeSend(ws, { event: "error", message: `Navigation: ${err.message}` });
  });

  safeSend(ws, {
    event: "ready",
    data: { url: page.url(), title: await page.title().catch(() => "") }
  });

  return session;
}

app.post("/api/session", async (req, res) => {
  try {
    if (sessions.size >= MAX_SESSIONS) {
      return res.status(429).json({ error: "Server sedang penuh. Tutup session lain terlebih dahulu." });
    }

    const url = await validateTarget(req.body?.url);
    const id = cryptoRandomId();
    pendingSessions.add(id);
    res.json({ id, wsPath: `/ws?session=${id}`, url });
  } catch (e) {
    res.status(400).json({ error: e.message || "Gagal membuat session." });
  }
});

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

wss.on("connection", async (ws, req) => {
  const q = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const id = q.get("session");

  if (!id) {
    ws.close(1008, "Invalid session");
    return;
  }
  if (sessions.has(id)) {
    const old = sessions.get(id);
    old.ws = ws;
    safeSend(ws, { event: "attached", data: { id } });
    return;
  }
  if (!pendingSessions.has(id)) {
    ws.close(1008, "Unknown session");
    return;
  }
  pendingSessions.delete(id);

  ws.once("message", async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "start") throw new Error("Invalid start message.");

      const url = await validateTarget(msg.url);
      await createSession(id, url, ws);

      ws.on("message", async raw2 => {
        try {
          const cmd = JSON.parse(raw2.toString());
          const s = sessions.get(id);
          if (!s) return;

          if (cmd.type === "reload") {
            await s.page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(e =>
              safeSend(ws, { event: "error", message: e.message })
            );
          }

          if (cmd.type === "navigate") {
            const target = await validateTarget(cmd.url);
            await s.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e =>
              safeSend(ws, { event: "error", message: e.message })
            );
          }

          if (cmd.type === "back") {
            await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(e =>
              safeSend(ws, { event: "error", message: e.message })
            );
          }

          if (cmd.type === "forward") {
            await s.page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(e =>
              safeSend(ws, { event: "error", message: e.message })
            );
          }

          if (cmd.type === "html") {
            const html = await s.page.content();
            safeSend(ws, { event: "html", data: trimBody(html) });
          }

          if (cmd.type === "storage") {
            const local = await s.page.evaluate(() => ({ ...localStorage }));
            const session = await s.page.evaluate(() => ({ ...sessionStorage }));
            const cookies = await s.context.cookies();
            safeSend(ws, { event: "storage", data: { local, session, cookies } });
          }

          if (cmd.type === "evaluate") {
            // Intentionally restricted: only read-only inspection expressions.
            const expression = String(cmd.expression || "").trim();
            if (!/^(document\.title|location\.href|document\.URL|document\.documentElement\.outerHTML)$/.test(expression)) {
              return safeSend(ws, { event: "error", message: "Expression tidak diizinkan." });
            }
            const value = await s.page.evaluate(exp => Function(`"use strict"; return (${exp})`)(), expression);
            safeSend(ws, { event: "evaluate", data: String(value) });
          }
        } catch (e) {
          safeSend(ws, { event: "error", message: e.message || "Command gagal." });
        }
      });
    } catch (e) {
      safeSend(ws, { event: "error", message: e.message || "Session gagal." });
      ws.close();
    }
  });

  ws.on("close", async () => {
    setTimeout(() => {
      if (sessions.has(id)) closeSession(id);
    }, 15000);
  });
});

setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - s.createdAt > SESSION_TTL) closeSession(id);
  }
}, 30000);

app.get("/health", (_req, res) => res.json({ ok: true, service: "FX Web Inspector" }));

server.listen(PORT, () => {
  console.log(`FX Web Inspector running on port ${PORT}`);
});