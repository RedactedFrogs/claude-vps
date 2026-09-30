#!/usr/bin/env node
// Turnstile captcha solver v4 — puppeteer-extra + stealth plugin
// Intercepts the page's own Turnstile flow instead of injecting a new widget
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const CHROME_PATH = "/usr/bin/google-chrome";

async function solve(sitekey, action, cdata) {
  const useXvfb = !process.env.DISPLAY;
  let xvfbProc;
  const display = `:${90 + Math.floor(Math.random() * 10)}`;

  if (useXvfb) {
    const { spawn: sp } = await import("node:child_process");
    xvfbProc = sp("Xvfb", [display, "-screen", "0", "1280x720x24", "-ac"], {
      stdio: "ignore", detached: true,
    });
    process.env.DISPLAY = display;
    await new Promise((r) => setTimeout(r, 800));
  }

  const browser = await puppeteerExtra.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1280,720",
      "--lang=en-US,en",
      `--display=${process.env.DISPLAY}`,
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const page = (await browser.pages())[0] || await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 720 });

    // Intercept turnstile token from any network request
    let resolveToken, rejectToken;
    const tokenPromise = new Promise((res, rej) => {
      resolveToken = res;
      rejectToken = rej;
    });
    const timeout = setTimeout(() => rejectToken(new Error("solve timeout 60s")), 60000);

    // Method 1: Intercept outgoing XHR/fetch that carries cf-turnstile-response
    page.on("request", (req) => {
      const url = req.url();
      const post = req.postData();
      if (post && post.includes("cf-turnstile-response=")) {
        const m = post.match(/cf-turnstile-response=([^&]+)/);
        if (m) { clearTimeout(timeout); resolveToken(decodeURIComponent(m[1])); }
      }
    });

    // Method 2: Expose a callback from inside the page
    await page.exposeFunction("__solverGotToken", (t) => {
      clearTimeout(timeout);
      resolveToken(t);
    });

    // Hook into turnstile.render to capture callback tokens
    await page.evaluateOnNewDocument((sk, act, cd) => {
      // Override turnstile.render once it's defined
      let hooked = false;
      const hookTurnstile = () => {
        if (hooked || !window.turnstile) return;
        hooked = true;
        const origRender = window.turnstile.render.bind(window.turnstile);
        window.turnstile.render = function(container, opts) {
          const origCb = opts.callback;
          opts.callback = (token) => {
            window.__solverGotToken(token);
            if (origCb) origCb(token);
          };
          return origRender(container, opts);
        };
      };
      // Check periodically until turnstile is defined
      const iv = setInterval(() => {
        hookTurnstile();
        if (hooked) clearInterval(iv);
      }, 50);
      setTimeout(() => clearInterval(iv), 30000);
    }, sitekey, action, cdata || "");

    // Navigate to gocollect.fun
    console.error("Navigating to gocollect.fun...");
    await page.goto("https://gocollect.fun", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.error("Page loaded, waiting for Turnstile...");

    // Wait for the page to fully load and Turnstile to initialize
    await new Promise((r) => setTimeout(r, 3000));

    // Check if turnstile is loaded, if not inject it and render manually
    const needsManualRender = await page.evaluate(() => !window.turnstile);

    if (needsManualRender) {
      console.error("Turnstile not found, loading manually...");
      await page.evaluate(async (sk, act, cd) => {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
          s.onload = () => {
            const t = setInterval(() => {
              if (window.turnstile) { clearInterval(t); resolve(); }
            }, 100);
            setTimeout(() => { clearInterval(t); reject(new Error("ts init timeout")); }, 15000);
          };
          s.onerror = () => reject(new Error("ts load fail"));
          document.head.appendChild(s);
        });

        const container = document.createElement("div");
        container.id = "cf-solver";
        container.style.cssText = "position:fixed;bottom:10px;left:10px;z-index:99999";
        document.body.appendChild(container);

        window.turnstile.render("#cf-solver", {
          sitekey: sk,
          action: act,
          cData: cd || undefined,
          theme: "light",
          size: "normal",
          retry: "auto",
          "retry-interval": 4000,
          callback: (t) => window.__solverGotToken(t),
          "error-callback": (e) => console.error("TS error:", e),
        });
      }, sitekey, action, cdata || "");
    } else {
      // Turnstile already exists — the hook we installed should capture it.
      // Also try to manually render a second widget as backup
      console.error("Turnstile found, rendering backup widget...");
      await page.evaluate((sk, act, cd) => {
        const container = document.createElement("div");
        container.id = "cf-solver-backup";
        container.style.cssText = "position:fixed;bottom:10px;right:10px;z-index:99999";
        document.body.appendChild(container);
        window.turnstile.render("#cf-solver-backup", {
          sitekey: sk,
          action: act,
          cData: cd || undefined,
          theme: "light",
          size: "normal",
          retry: "auto",
          "retry-interval": 4000,
          callback: (t) => window.__solverGotToken(t),
          "error-callback": (e) => console.error("TS error:", e),
        });
      }, sitekey, action, cdata || "");
    }

    // If there's a visible Turnstile checkbox iframe, click it
    try {
      await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 10000 });
      console.error("Turnstile iframe found, attempting click...");
      const frames = page.frames();
      for (const frame of frames) {
        if (frame.url().includes("challenges.cloudflare.com")) {
          try {
            // Wait for the checkbox/verify element
            const checkbox = await frame.waitForSelector(
              'input[type="checkbox"], .cb-i, #challenge-stage',
              { timeout: 5000 }
            );
            if (checkbox) {
              await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
              await checkbox.click();
              console.error("Clicked Turnstile element");
            }
          } catch { /* no clickable element, managed mode */ }
        }
      }
    } catch {
      console.error("No Turnstile iframe found (managed mode)");
    }

    console.error("Waiting for token...");
    const token = await tokenPromise;
    console.error("Token received!");
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
