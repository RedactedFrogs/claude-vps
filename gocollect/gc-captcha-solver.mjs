#!/usr/bin/env node
// gc-captcha-solver v6 — exact replica of gocollect.fun's Turnstile flow
// Based on reverse-engineering index-TJhw5QIF.js function Cv()
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const CHROME_PATH = "/usr/bin/google-chrome";
const SITEKEY = "0x4AAAAAAFFEEqjfwjZSKSA0";
const TS_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SOLVE_TIMEOUT = 15000; // 15s, same as app (fS=15e3)

function rand(a, b) { return a + Math.random() * (b - a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function humanMouse(page, n = 5) {
  const vp = page.viewport();
  let x = rand(100, vp.width - 100), y = rand(100, vp.height - 100);
  for (let i = 0; i < n; i++) {
    x = Math.max(10, Math.min(vp.width - 10, x + rand(-80, 80)));
    y = Math.max(10, Math.min(vp.height - 10, y + rand(-60, 60)));
    await page.mouse.move(x, y, { steps: Math.floor(rand(3, 8)) });
    await sleep(rand(40, 150));
  }
}

// Single solve attempt — replicates Cv(action, cData) from the bundle
async function solveSingle(page, action, cdata) {
  return page.evaluate(async (sk, tsUrl, act, cd, timeout) => {
    // Load turnstile if not present (same as Fw())
    if (!window.turnstile) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = tsUrl;
        s.async = true;
        s.onload = () => {
          if (window.turnstile) res(); else rej(new Error("no-turnstile"));
        };
        s.onerror = () => rej(new Error("load-failed"));
        document.head.appendChild(s);
      });
    }

    // Create container — exact same style as app
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647";
    document.body.appendChild(el);

    let wid;
    try {
      return await new Promise(resolve => {
        const to = setTimeout(() => resolve({ error: "timeout" }), timeout);
        const done = r => { clearTimeout(to); resolve(r); };

        // Render with EXACT same params as app's Cv()
        wid = window.turnstile.render(el, {
          sitekey: sk,
          ...(cd ? { cData: cd } : {}),
          action: act,
          appearance: "interaction-only",
          execution: "execute",
          callback: t => done({ token: t }),
          "error-callback": e => (done({ error: "error:" + String(e ?? "").slice(0, 40) }), true),
          "timeout-callback": () => done({ error: "timeout" }),
          "unsupported-callback": () => done({ error: "unsupported" }),
        });

        // CRITICAL: must call execute() — this starts the challenge!
        window.turnstile.execute(wid);
      });
    } catch (e) {
      return { error: "exception:" + String(e?.name ?? e?.message ?? "").slice(0, 40) };
    } finally {
      try { if (wid !== undefined) window.turnstile.remove(wid); } catch {}
      el.remove();
    }
  }, SITEKEY, TS_URL, action, cdata || "", SOLVE_TIMEOUT);
}

// Double attempt with retry — replicates Uw(action, cData)
async function solveWithRetry(page, action, cdata) {
  const first = await solveSingle(page, action, cdata);
  if (first.token || first.error === "off" || first.error === "unsupported") return first;
  console.error(`[solver] Attempt 1 failed: ${first.error}, retrying...`);
  await sleep(rand(500, 1500));
  const second = await solveSingle(page, action, cdata);
  if (second.token) return second;
  return { error: `${first.error}+${second.error}`.slice(0, 60) };
}

async function solve(action, cdata) {
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

    // Navigate to gocollect.fun — let CF challenge platform iframe run
    console.error("[solver] Navigating to gocollect.fun...");
    await page.goto("https://gocollect.fun", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for page to fully load (CF challenge platform runs in hidden iframe)
    await page.waitForFunction(() => document.readyState === "complete", { timeout: 15000 }).catch(() => {});

    // Human-like behavior while CF challenge platform processes
    console.error("[solver] Waiting for CF challenge + human sim...");
    await sleep(rand(2000, 3000));
    await humanMouse(page, 8);
    await sleep(rand(1000, 2000));
    await humanMouse(page, 5);
    await sleep(rand(1000, 2000));

    // Now solve Turnstile using exact same flow as the app
    console.error("[solver] Solving Turnstile (attempt 1+2)...");
    const result = await solveWithRetry(page, action, cdata);

    if (result.token) {
      console.error("[solver] Success!");
      return result.token;
    }
    throw new Error(result.error || "unknown");
  } finally {
    await browser.close();
    if (xvfbProc) { xvfbProc.kill(); }
  }
}

const [, , action, cdata] = process.argv;
if (!action) {
  console.error("Usage: node gc-captcha-solver.mjs <action> [cdata]");
  console.error("  action: signin | open");
  console.error("  cdata:  nonce (for signin) or sha256-prefix (for open)");
  process.exit(1);
}

try {
  const token = await solve(action, cdata);
  process.stdout.write(token);
} catch (e) {
  console.error("SOLVER_ERROR: " + e.message);
  process.exit(1);
}
