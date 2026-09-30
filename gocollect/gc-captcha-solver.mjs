#!/usr/bin/env node
// Turnstile captcha solver v5 — stealth + human behavior simulation
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const CHROME_PATH = "/usr/bin/google-chrome";

function rand(min, max) { return min + Math.random() * (max - min); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function humanMouseMove(page, steps = 5) {
  const vp = page.viewport();
  let x = rand(100, vp.width - 100), y = rand(100, vp.height - 100);
  for (let i = 0; i < steps; i++) {
    x += rand(-80, 80);
    y += rand(-60, 60);
    x = Math.max(10, Math.min(vp.width - 10, x));
    y = Math.max(10, Math.min(vp.height - 10, y));
    await page.mouse.move(x, y, { steps: Math.floor(rand(3, 8)) });
    await sleep(rand(50, 200));
  }
}

async function humanScroll(page) {
  await page.evaluate(() => {
    window.scrollBy(0, Math.floor(Math.random() * 200 + 50));
  });
  await sleep(rand(300, 800));
  await page.evaluate(() => {
    window.scrollBy(0, -Math.floor(Math.random() * 100 + 30));
  });
}

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
    await sleep(800);
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

    // Token capture setup
    let resolveToken, rejectToken;
    const tokenPromise = new Promise((res, rej) => {
      resolveToken = res;
      rejectToken = rej;
    });
    const timeout = setTimeout(() => rejectToken(new Error("solve timeout 90s")), 90000);

    // Expose callback for token capture
    await page.exposeFunction("__solverGotToken", (t) => {
      clearTimeout(timeout);
      resolveToken(t);
    });

    // Hook turnstile.render to capture token via callback
    await page.evaluateOnNewDocument(() => {
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
      const iv = setInterval(() => {
        hookTurnstile();
        if (hooked) clearInterval(iv);
      }, 50);
      setTimeout(() => clearInterval(iv), 30000);
    });

    // Navigate to page
    console.error("[solver] Navigating...");
    await page.goto("https://gocollect.fun", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Simulate human-like behavior before Turnstile renders
    console.error("[solver] Simulating human behavior...");
    await sleep(rand(1000, 2000));
    await humanMouseMove(page, 8);
    await sleep(rand(500, 1000));
    await humanScroll(page);
    await sleep(rand(500, 1500));
    await humanMouseMove(page, 5);
    await sleep(rand(1000, 2000));

    // Wait for page to fully load
    await page.waitForFunction(() => document.readyState === "complete", { timeout: 15000 }).catch(() => {});
    await sleep(rand(500, 1000));

    // Check if turnstile is already loaded by the page
    const hasTurnstile = await page.evaluate(() => !!window.turnstile);
    console.error(`[solver] Turnstile present: ${hasTurnstile}`);

    if (!hasTurnstile) {
      // Load turnstile manually
      console.error("[solver] Loading Turnstile script...");
      await page.evaluate(() => {
        return new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
          s.onload = () => {
            const t = setInterval(() => {
              if (window.turnstile) { clearInterval(t); resolve(); }
            }, 100);
            setTimeout(() => { clearInterval(t); reject(new Error("ts init timeout")); }, 20000);
          };
          s.onerror = () => reject(new Error("ts load fail"));
          document.head.appendChild(s);
        });
      });
    }

    // More human behavior before rendering widget
    await humanMouseMove(page, 4);
    await sleep(rand(500, 1000));

    // Render Turnstile widget
    console.error("[solver] Rendering Turnstile widget...");
    await page.evaluate((sk, act, cd) => {
      const container = document.createElement("div");
      container.id = "cf-solver";
      container.style.cssText = "position:fixed;bottom:10px;left:10px;z-index:99999;background:#fff;padding:5px;border-radius:4px";
      document.body.appendChild(container);

      window.turnstile.render("#cf-solver", {
        sitekey: sk,
        action: act,
        cData: cd || undefined,
        theme: "light",
        size: "normal",
        retry: "auto",
        "retry-interval": 5000,
        callback: (t) => window.__solverGotToken(t),
        "error-callback": (e) => console.error("TS error:", e),
        "timeout-callback": () => console.error("TS timeout"),
      });
    }, sitekey, action, cdata || "");

    // Simulate more human activity while waiting
    console.error("[solver] Widget rendered, simulating activity while waiting...");

    // Background human simulation loop
    const humanLoop = (async () => {
      for (let i = 0; i < 15; i++) {
        await sleep(rand(2000, 4000));
        await humanMouseMove(page, rand(2, 5));
        if (Math.random() > 0.5) await humanScroll(page);
      }
    })();

    // Try to click Turnstile iframe checkbox if visible
    sleep(3000).then(async () => {
      try {
        const iframes = await page.$$('iframe[src*="challenges.cloudflare.com"]');
        for (const iframe of iframes) {
          const frame = await iframe.contentFrame();
          if (!frame) continue;
          try {
            const el = await frame.waitForSelector(
              'input[type="checkbox"], .cb-i, #challenge-stage, [role="checkbox"]',
              { timeout: 3000 }
            );
            if (el) {
              await sleep(rand(300, 800));
              const box = await el.boundingBox();
              if (box) {
                await page.mouse.move(
                  box.x + box.width / 2 + rand(-3, 3),
                  box.y + box.height / 2 + rand(-3, 3),
                  { steps: Math.floor(rand(5, 12)) }
                );
                await sleep(rand(100, 300));
                await page.mouse.click(
                  box.x + box.width / 2 + rand(-2, 2),
                  box.y + box.height / 2 + rand(-2, 2)
                );
                console.error("[solver] Clicked Turnstile element");
              }
            }
          } catch { /* managed mode, no clickable element */ }
        }
      } catch { /* no iframe */ }
    });

    console.error("[solver] Waiting for token...");
    const token = await tokenPromise;
    console.error("[solver] Got token!");
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
