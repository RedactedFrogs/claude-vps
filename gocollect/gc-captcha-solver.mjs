#!/usr/bin/env node
// Turnstile captcha solver via headless Chrome
// Navigate to gocollect.fun (correct origin), wait for Turnstile JS to load,
// then render widget with specified action/cData
// Usage: node gc-captcha-solver.mjs <sitekey> <action> [cdata]

import puppeteer from "puppeteer-core";

const CHROME_PATH = "/usr/bin/google-chrome";

async function solve(sitekey, action, cdata) {
  const useXvfb = !process.env.DISPLAY;
  let xvfbProc;
  const display = `:${90 + Math.floor(Math.random() * 10)}`;

  if (useXvfb) {
    const { spawn: sp } = await import("node:child_process");
    xvfbProc = sp("Xvfb", [display, "-screen", "0", "412x915x24", "-ac"], {
      stdio: "ignore", detached: true,
    });
    process.env.DISPLAY = display;
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=412,915",
      "--lang=en-US,en",
      `--display=${process.env.DISPLAY}`,
    ],
  });

  try {
    const page = await browser.newPage();

    // Stealth: remove webdriver traces
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
      Object.defineProperty(navigator, "plugins", {
        get: () => {
          const arr = [
            { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
            { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
            { name: "Native Client", filename: "internal-nacl-plugin" },
          ];
          arr.refresh = () => {};
          return arr;
        },
      });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "platform", { get: () => "Linux armv81" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });

      // WebGL vendor/renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return "Google Inc. (Qualcomm)";
        if (param === 37446) return "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)";
        return getParameter.call(this, param);
      };

      // Permissions
      const originalQuery = window.Permissions?.prototype?.query;
      if (originalQuery) {
        window.Permissions.prototype.query = (params) =>
          params.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery.call(window.Permissions.prototype, params);
      }
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Mobile Safari/537.36"
    );
    await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 });

    // Navigate to gocollect.fun favicon (lightweight, sets origin correctly)
    await page.goto("https://gocollect.fun/favicon.ico", {
      waitUntil: "load",
      timeout: 20000,
    }).catch(() => {});

    // Navigate to actual page with domcontentloaded (faster than networkidle)
    await page.goto("https://gocollect.fun", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Short wait for page scripts to initialize
    await new Promise((r) => setTimeout(r, 2000));

    // Render Turnstile widget with our action/cData
    const token = await page.evaluate(
      async (sk, act, cd) => {
        // Create a container div (append, don't replace body)
        const container = document.createElement("div");
        container.id = "cf-solver";
        container.style.cssText = "position:fixed;bottom:0;left:0;z-index:99999";
        document.body.appendChild(container);

        // Wait for turnstile to be available (page already loads it)
        if (!window.turnstile) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
            s.onload = () => {
              const t = setInterval(() => {
                if (window.turnstile) { clearInterval(t); resolve(); }
              }, 100);
              setTimeout(() => { clearInterval(t); reject(new Error("turnstile init timeout")); }, 20000);
            };
            s.onerror = () => reject(new Error("turnstile script load failed"));
            document.head.appendChild(s);
          });
        }

        return new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error("solve timeout 45s")), 45000);
          const opts = {
            sitekey: sk,
            action: act,
            theme: "dark",
            size: "normal",
            retry: "auto",
            "retry-interval": 3000,
            callback: (t) => { clearTimeout(to); resolve(t); },
            "error-callback": (e) => { clearTimeout(to); reject(new Error("turnstile error: " + e)); },
            "timeout-callback": () => { clearTimeout(to); reject(new Error("turnstile timeout")); },
            "expired-callback": () => { clearTimeout(to); reject(new Error("turnstile expired")); },
          };
          if (cd) opts.cData = cd;
          window.turnstile.render("#cf-solver", opts);
        });
      },
      sitekey,
      action,
      cdata || ""
    );

    return token;
  } finally {
    await browser.close();
    if (xvfbProc) { xvfbProc.kill(); }
  }
}

const [sitekey, action, cdata] = process.argv.slice(2);
if (!sitekey || !action) {
  console.error("Usage: node gc-captcha-solver.mjs <sitekey> <action> [cdata]");
  process.exit(1);
}

try {
  const token = await solve(sitekey, action, cdata);
  process.stdout.write(token);
} catch (e) {
  console.error("SOLVER_ERROR: " + e.message);
  process.exit(1);
}
