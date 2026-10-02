#!/usr/bin/env node
// gc-token-relay.mjs — Token relay for GoCollect captcha solving
//
// Bot (gc-farm.mjs) ←→ Relay (:18800) ←→ User's browser (harvester page)
//
// Usage:
//   node gc-token-relay.mjs              # start relay
//   node gc-token-relay.mjs --with-tunnel # start relay + cloudflared tunnel

import http from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.RELAY_PORT || "18800");
const KEYS_FILE = resolve(__dirname, "gc-keys.json");
const TUNNEL_URL_FILE = resolve(__dirname, "relay_tunnel_url.txt");

const pending = new Map();
const STATS_FILE = resolve(__dirname, "gc-stats.json");
const STATE_FILE = resolve(__dirname, "gc-state.json");
let tokensSolved = 0;
let tokensErrors = 0;
const relayStart = Date.now();

function getSitekey() {
  try {
    if (existsSync(KEYS_FILE)) return JSON.parse(readFileSync(KEYS_FILE, "utf-8")).sitekey;
  } catch {}
  return "";
}

function readBody(req) {
  return new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
}

function genId() {
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function harvesterPage(sitekey, relayOrigin) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GC Harvester</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px;text-align:center;margin:0}
h2{color:#34d399;margin:8px 0}
.stats{color:#94a3b8;font-size:14px;margin-bottom:12px}
#widget{display:flex;justify-content:center;min-height:70px;margin:8px 0}
#status{padding:12px;border-radius:8px;margin:8px auto;max-width:420px;font-size:14px}
.idle{background:#1e293b}.solving{background:#1e3a5f;color:#93c5fd}
.ok{background:#064e3b;color:#6ee7b7}.err{background:#7f1d1d;color:#fca5a5}
#log{text-align:left;font-size:11px;color:#64748b;margin-top:12px;max-height:200px;overflow-y:auto;padding:0 8px}
#log div{border-bottom:1px solid #1e293b;padding:2px 0}
.fallback{margin-top:20px;padding:12px;background:#1e293b;border-radius:8px;text-align:left;font-size:12px}
.fallback summary{cursor:pointer;color:#94a3b8}
.fallback code{background:#0f172a;padding:2px 6px;border-radius:4px;font-size:11px;word-break:break-all}
</style></head><body>
<h2>Token Harvester</h2>
<p class="stats">Solved: <b id="cnt">0</b> &nbsp; Errors: <b id="errs">0</b> &nbsp; <span id="uptime"></span></p>
<div id="widget"></div>
<div id="status" class="idle">Menunggu request dari bot...</div>
<div id="log"></div>

<details class="fallback"><summary>Tidak jalan? Klik untuk fallback (console script)</summary>
<p>Kalau halaman ini tidak bisa solve (domain lock), buka <b>gocollect.fun</b> di Chrome, tekan F12 (DevTools), paste script ini di Console:</p>
<pre><code id="fb-script">Loading...</code></pre>
</details>

<script>
const SK="${sitekey}";
const RELAY="${relayOrigin}";
let solved=0,errs=0,startTime=Date.now();

function addLog(m){
  const el=document.getElementById("log");
  const d=new Date().toLocaleTimeString("id-ID",{timeZone:"Asia/Jakarta"});
  el.innerHTML='<div>['+d+'] '+m+'</div>'+el.innerHTML;
  while(el.children.length>40)el.lastChild.remove();
}

function setStatus(c,t){const el=document.getElementById("status");el.className=c;el.textContent=t}

function updateUptime(){
  const s=Math.floor((Date.now()-startTime)/1000);
  const m=Math.floor(s/60),h=Math.floor(m/60);
  document.getElementById("uptime").textContent=
    h>0?h+"j "+m%60+"m":m>0?m+"m "+s%60+"s":s+"s";
}
setInterval(updateUptime,1000);

async function solveTurnstile(action,cdata){
  const el=document.getElementById("widget");
  el.innerHTML="";
  const container=document.createElement("div");
  el.appendChild(container);
  let wid;
  try{
    return await new Promise(resolve=>{
      const to=setTimeout(()=>resolve({error:"timeout"}),25000);
      const done=r=>{clearTimeout(to);resolve(r)};
      wid=window.turnstile.render(container,{
        sitekey:SK,
        ...(cdata?{cData:cdata}:{}),
        action:action,
        appearance:"interaction-only",
        execution:"execute",
        callback:t=>done({token:t}),
        "error-callback":e=>{done({error:"cf:"+String(e).slice(0,30)});return true},
        "timeout-callback":()=>done({error:"timeout"}),
        "unsupported-callback":()=>done({error:"unsupported"}),
      });
      window.turnstile.execute(wid);
    });
  }catch(e){return{error:"render:"+e.message.slice(0,30)}}
  finally{try{if(wid!==undefined)window.turnstile.remove(wid)}catch{};el.innerHTML=""}
}

async function loop(){
  while(true){
    try{
      const res=await fetch(RELAY+"/pending");
      const list=await res.json();
      for(const req of list){
        setStatus("solving","Solving: "+req.action+"...");
        addLog("Request: "+req.action+" cdata="+(req.cdata||"").slice(0,8)+"...");
        const r=await solveTurnstile(req.action,req.cdata);
        if(r.token){
          solved++;document.getElementById("cnt").textContent=solved;
          setStatus("ok","Solved! ("+r.token.length+" chars)");
          addLog("\\u2713 Solved "+r.token.slice(0,16)+"...");
          await fetch(RELAY+"/fulfill",{method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({id:req.id,token:r.token})});
        }else{
          errs++;document.getElementById("errs").textContent=errs;
          setStatus("err","Error: "+r.error);
          addLog("\\u2717 "+r.error);
          await fetch(RELAY+"/fulfill",{method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({id:req.id,error:r.error})});
        }
      }
      if(list.length>0)setTimeout(()=>setStatus("idle","Menunggu request berikutnya..."),2000);
    }catch(e){/* retry */}
    await new Promise(r=>setTimeout(r,2000));
  }
}

function boot(){
  if(window.turnstile){addLog("Turnstile loaded, harvester active!");loop()}
  else setTimeout(boot,500);
}

// Generate fallback console script
document.getElementById("fb-script").textContent=
  '(async()=>{const R="'+RELAY+'",SK="'+SK+'";'
  +'if(!window.turnstile){const s=document.createElement("script");'
  +'s.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";'
  +'document.head.appendChild(s);await new Promise(r=>{const i=setInterval(()=>{if(window.turnstile){clearInterval(i);r()}},200)})}'
  +'console.log("[harvester] Active on "+location.hostname);'
  +'while(true){try{const p=await(await fetch(R+"/pending")).json();'
  +'for(const q of p){console.log("[harvester] Solving:",q.action);'
  +'const el=document.createElement("div");el.style.cssText="position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:99999";'
  +'document.body.appendChild(el);let w;'
  +'const r=await new Promise(ok=>{const t=setTimeout(()=>ok({error:"timeout"}),25e3);'
  +'w=turnstile.render(el,{sitekey:SK,...(q.cdata?{cData:q.cdata}:{}),action:q.action,'
  +'appearance:"interaction-only",execution:"execute",'
  +'callback:v=>{clearTimeout(t);ok({token:v})},'
  +'"error-callback":e=>{clearTimeout(t);ok({error:String(e)});return true},'
  +'"timeout-callback":()=>{clearTimeout(t);ok({error:"timeout"})}});'
  +'turnstile.execute(w)});'
  +'try{if(w!==undefined)turnstile.remove(w)}catch{};el.remove();'
  +'await fetch(R+"/fulfill",{method:"POST",headers:{"Content-Type":"application/json"},'
  +'body:JSON.stringify({id:q.id,...(r.token?{token:r.token}:{error:r.error})})});'
  +'console.log("[harvester]",r.token?"OK":"ERR:"+r.error)}'
  +'}catch(e){}await new Promise(r=>setTimeout(r,2e3))}})()';

addLog("Loading Turnstile...");
boot();
</script></body></html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GC Farm Dashboard</title>
<style>
*{box-sizing:border-box;margin:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px}
h1{color:#34d399;font-size:20px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
h1 span{font-size:12px;padding:3px 8px;border-radius:12px;font-weight:normal}
.live{background:#064e3b;color:#34d399}.off{background:#7f1d1d;color:#fca5a5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.card{background:#1e293b;border-radius:10px;padding:14px;text-align:center}
.card .val{font-size:28px;font-weight:700;color:#f1f5f9}
.card .lbl{font-size:11px;color:#94a3b8;margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
.card.green .val{color:#34d399}
.card.blue .val{color:#60a5fa}
.card.yellow .val{color:#fbbf24}
.card.red .val{color:#f87171}
.card.purple .val{color:#a78bfa}
.section{background:#1e293b;border-radius:10px;padding:14px;margin-bottom:12px}
.section h3{font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#64748b;font-weight:500;padding:4px 8px;border-bottom:1px solid #334155}
td{padding:6px 8px;border-bottom:1px solid #1e293b}
.status{display:inline-block;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600}
.s-logged_in,.s-farming,.s-walking_to_crate,.s-opening_crate{background:#064e3b;color:#34d399}
.s-logging_in,.s-idle{background:#1e3a5f;color:#93c5fd}
.s-break{background:#78350f;color:#fbbf24}
.s-error,.s-banned,.s-no_crates{background:#7f1d1d;color:#fca5a5}
.wins{max-height:180px;overflow-y:auto}
.wins .win{padding:6px 0;border-bottom:1px solid #334155;font-size:13px}
.wins .reward{color:#fbbf24;font-weight:600}
.wins .time{color:#64748b;font-size:11px}
.upd{text-align:center;color:#475569;font-size:11px;margin-top:8px}
@media(max-width:480px){.grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<h1>GoCollect Farm <span id="live" class="off">OFFLINE</span></h1>
<div class="grid">
  <div class="card green"><div class="val" id="opened">-</div><div class="lbl">Opened</div></div>
  <div class="card yellow"><div class="val" id="wins">-</div><div class="lbl">Wins</div></div>
  <div class="card blue"><div class="val" id="winrate">-</div><div class="lbl">Win Rate</div></div>
  <div class="card purple"><div class="val" id="tokens">-</div><div class="lbl">Tokens Solved</div></div>
  <div class="card"><div class="val" id="errors">-</div><div class="lbl">Errors</div></div>
  <div class="card"><div class="val" id="uptime">-</div><div class="lbl">Uptime</div></div>
</div>
<div class="section">
  <h3>Wallets</h3>
  <table><thead><tr><th>Wallet</th><th>Status</th><th>Opened</th><th>Wins</th><th>Last Active</th></tr></thead>
  <tbody id="wallets"><tr><td colspan="5" style="color:#64748b">Waiting...</td></tr></tbody></table>
</div>
<div class="section">
  <h3>Recent Wins</h3>
  <div class="wins" id="winlist"><div style="color:#64748b">No wins yet</div></div>
</div>
<div class="upd">Auto-refresh 5s &mdash; <span id="lastupd">-</span></div>
<script>
function fmt(s){
  if(s<60)return s+"s";
  const m=Math.floor(s/60),h=Math.floor(m/60);
  return h>0?h+"j "+m%60+"m":m+"m "+s%60+"s";
}
function wib(iso){
  if(!iso)return"-";
  return new Date(iso).toLocaleTimeString("id-ID",{timeZone:"Asia/Jakarta",hour:"2-digit",minute:"2-digit"});
}
async function refresh(){
  try{
    const r=await fetch("/stats");
    const d=await r.json();
    const rl=d.relay||{};
    const today=new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Jakarta"});
    const day=d.bot?.days?.[today]||{opened:0,wins:[],errors:0};
    const ws=d.bot?.wallets||{};
    const st=d.state;
    document.getElementById("live").textContent=st?"LIVE":"OFFLINE";
    document.getElementById("live").className=st?"live":"off";
    document.getElementById("opened").textContent=day.opened||0;
    document.getElementById("wins").textContent=(day.wins||[]).length;
    document.getElementById("winrate").textContent=day.opened>0?((day.wins||[]).length/day.opened*100).toFixed(1)+"%":"0%";
    document.getElementById("tokens").textContent=rl.tokensSolved||0;
    document.getElementById("errors").textContent=day.errors||0;
    document.getElementById("uptime").textContent=fmt(rl.uptime||0);
    const wArr=st?.wallets||Object.entries(ws).map(([a,w])=>({addr:a.slice(0,10)+"...",status:w.status,...w}));
    let wh="";
    if(wArr.length===0)wh='<tr><td colspan="5" style="color:#64748b">No wallets</td></tr>';
    for(const w of wArr){
      const cls="s-"+(w.status||"idle").replace(/[^a-z_]/g,"");
      wh+="<tr><td>"+((w.address||w.addr||"").slice(0,10))+"...</td>";
      wh+='<td><span class="status '+cls+'">'+(w.status||"idle")+"</span></td>";
      wh+="<td>"+(w.totalOpened||0)+"</td><td>"+(w.totalWins||0)+"</td>";
      wh+="<td>"+wib(w.lastActive)+"</td></tr>";
    }
    document.getElementById("wallets").innerHTML=wh;
    const allWins=[...((day.wins||[]).slice().reverse())];
    if(allWins.length===0){document.getElementById("winlist").innerHTML='<div style="color:#64748b">No wins yet today</div>';}
    else{let wl="";for(const w of allWins.slice(0,20)){wl+='<div class="win"><span class="reward">'+w.reward+'</span> &mdash; crate '+((w.crateId||"").slice(0,8))+'... <span class="time">'+w.time+" ("+w.wallet+")</span></div>";}document.getElementById("winlist").innerHTML=wl;}
    document.getElementById("lastupd").textContent=new Date().toLocaleTimeString("id-ID",{timeZone:"Asia/Jakarta"});
  }catch(e){document.getElementById("live").textContent="ERROR";document.getElementById("live").className="off";}
}
refresh();setInterval(refresh,5000);
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    const sk = getSitekey();
    if (!sk) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("ERROR: gc-keys.json not found. Run gc-farm.mjs --update-keys first.");
      return;
    }
    const relayOrigin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(harvesterPage(sk, relayOrigin));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pending: pending.size, sitekey: !!getSitekey() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/request") {
    const body = JSON.parse(await readBody(req));
    const id = genId();
    const timeoutMs = Math.min(parseInt(body.timeout) || 120000, 300000);

    console.log(
      `[${ts()}] REQ id=${id} action=${body.action} cdata=${(body.cdata || "").slice(0, 8)}...`
    );

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        resolve({ error: "timeout_no_harvester" });
      }, timeoutMs);
      pending.set(id, { action: body.action, cdata: body.cdata || "", resolve, timeout });
    });

    console.log(
      `[${ts()}] RES id=${id} ${result.token ? "OK " + result.token.length + "ch" : "ERR " + result.error}`
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "GET" && url.pathname === "/pending") {
    const list = [];
    for (const [id, { action, cdata }] of pending) list.push({ id, action, cdata });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  if (req.method === "POST" && url.pathname === "/fulfill") {
    const body = JSON.parse(await readBody(req));
    const entry = pending.get(body.id);
    if (entry) {
      clearTimeout(entry.timeout);
      pending.delete(body.id);
      if (body.token) { tokensSolved++; } else { tokensErrors++; }
      entry.resolve(body.token ? { token: body.token } : { error: body.error || "failed" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"expired"}');
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/stats") {
    let botStats = null, botState = null;
    try { if (existsSync(STATS_FILE)) botStats = JSON.parse(readFileSync(STATS_FILE, "utf-8")); } catch {}
    try { if (existsSync(STATE_FILE)) botState = JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      relay: { uptime: Math.floor((Date.now() - relayStart) / 1000), pending: pending.size, tokensSolved, tokensErrors },
      bot: botStats, state: botState,
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardPage());
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

function ts() {
  return new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[${ts()}] Token relay on :${PORT}`);
});

if (process.argv.includes("--with-tunnel")) {
  console.log(`[${ts()}] Starting cloudflared tunnel...`);
  const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (d) => {
    const m = d.toString().match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (m) {
      console.log(`[${ts()}] Tunnel: ${m[1]}`);
      try {
        writeFileSync(TUNNEL_URL_FILE, m[1]);
      } catch {}
    }
  };
  cf.stdout.on("data", onData);
  cf.stderr.on("data", onData);
  cf.on("error", (e) => console.error(`[${ts()}] Tunnel error: ${e.message}`));
  cf.on("close", (code) => {
    console.error(`[${ts()}] Tunnel exited (${code}), restarting in 5s...`);
    setTimeout(() => process.exit(1), 5000);
  });
}
