#!/usr/bin/env node
// Turnstile captcha solver via headless Chrome
// Buka gocollect.fun (domain asli) lalu inject widget → token valid
// Usage: node gc-captcha-solver.mjs <sitekey> <action> [cdata]

import puppeteer from "puppeteer-core";

const CHROME_PATH = "/usr/bin/google-chrome";
const TIMEOUT = 45000;

async function solve(sitekey, action, cdata) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=412,915",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      delete navigator.__proto__.webdriver;
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
    );
    await page.setViewport({ width: 412, height: 915, isMobile: true });

    await page.goto("https://gocollect.fun", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const token = await page.evaluate(
      async (sk, act, cd) => {
        document.body.innerHTML = '<div id="ts"></div>';

        if (!window.turnstile) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
            s.onload = () => {
              const t = setInterval(() => {
                if (window.turnstile) { clearInterval(t); resolve(); }
              }, 100);
              setTimeout(() => { clearInterval(t); reject(new Error("init timeout")); }, 15000);
            };
            s.onerror = () => reject(new Error("script load failed"));
            document.head.appendChild(s);
          });
        }

        return new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error("solve timeout")), 30000);
          const opts = {
            sitekey: sk,
            action: act,
            theme: "dark",
            callback: (t) => { clearTimeout(to); resolve(t); },
            "error-callback": (e) => { clearTimeout(to); reject(new Error("turnstile error: " + e)); },
            "timeout-callback": () => { clearTimeout(to); reject(new Error("turnstile timeout")); },
          };
          if (cd) opts.cData = cd;
          window.turnstile.render("#ts", opts);
        });
      },
      sitekey,
      action,
      cdata || ""
    );

    return token;
  } finally {
    await browser.close();
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
