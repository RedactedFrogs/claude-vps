#!/usr/bin/env node
/**
 * Extract level layout from KenzoCoin game JS.
 * Runs the actual level generator to get exact checkpoint and finish positions.
 * Usage: node kenzo_level_extract.js <seed> [gate]
 */

const fs = require('fs');

// Read the game JS
const jsPath = '/tmp/kenzo_app.js';
if (!fs.existsSync(jsPath)) {
  console.error('Download app.js first: curl -o /tmp/kenzo_app.js "https://kenzocoin.meme/v2/play/app.js?v=80137626"');
  process.exit(1);
}

const js = fs.readFileSync(jsPath, 'utf8');

// Find the game-specific code section
// It starts around "function gy(" and contains all the level logic
const gyIdx = js.indexOf('function gy(');
if (gyIdx < 0) {
  console.error('Could not find gy function');
  process.exit(1);
}

// Find end of level generator - the Hh function ends with r.gravs=...,r}
const hhEnd = js.indexOf('r.dizzy=r.els.filter(c=>c.k==="dizzy"),r.gravs=r.els.filter(c=>c.k==="grav"),r}');
if (hhEnd < 0) {
  console.error('Could not find end of Hh');
  process.exit(1);
}
const codeEnd = hhEnd + 'r.dizzy=r.els.filter(c=>c.k==="dizzy"),r.gravs=r.els.filter(c=>c.k==="grav"),r}'.length;

// Find Gf array - it's before gy but after some helper functions
// Search backwards from gy for the start of the game section
// Actually Gf might be after Hh. Let's search for it.
let gfIdx = js.indexOf(',Gf=[', gyIdx);
if (gfIdx < 0) gfIdx = js.indexOf('Gf=[', gyIdx);
if (gfIdx < 0) {
  console.error('Could not find Gf array');
  process.exit(1);
}

// Find end of Gf array
let depth = 0, gfEnd = gfIdx;
for (let i = js.indexOf('[', gfIdx); i < js.length; i++) {
  if (js[i] === '[') depth++;
  else if (js[i] === ']') {
    depth--;
    if (depth === 0) { gfEnd = i + 1; break; }
  }
}

// Extract code chunks
const start = Math.min(gyIdx, gfIdx);
const end = Math.max(codeEnd, gfEnd);

console.error(`Extracting chars ${start}-${end} (${end-start} chars)`);

// Build executable code
// Need to provide stubs for dependencies
const preamble = `
// Stubs
var Ae = Math.PI * 2; // tau
var kh = (n,t,e) => n < t ? t : n > e ? e : n;
var $i = (n,t) => ((n % t) + t) % t;
`;

let gameCode = js.substring(start, end);

// The code might reference variables defined before our extract range
// Add any missing ones
const postCode = `
// Extract level for given seed and gate
const seed = parseInt(process.argv[2] || '0');
const gate = parseInt(process.argv[3] || '0');

if (!seed) {
  console.error('Usage: node kenzo_level_extract.js <seed> [gate]');
  process.exit(1);
}

try {
  const level = Hh(gate, seed);
  const result = {
    gate: gate,
    seed: seed,
    name: level.name,
    finishZ: level.finishZ,
    gateZ: level.gateZ,
    end: level.end,
    sweep: level.sweep,
    checkpoints: level.cps,
    segments: level.segs,
    platforms: level.els.filter(e => e.k === 'box').map(e => ({
      x: e.x, z: e.z, w: e.w, d: e.d,
      top: e.top || 0, h: e.h || 1,
      style: e.style, cp: e.cp || false,
      trap: e.trap, fake: e.fake
    })),
    goldPlatform: level.els.filter(e => e.style === 'gold' && !e.trap).map(e => ({
      x: e.x, z: e.z, w: e.w, d: e.d, top: e.top || 0
    }))[0]
  };
  console.log(JSON.stringify(result, null, 2));
} catch(e) {
  console.error('Error running level generator:', e.message);
  console.error(e.stack);
  process.exit(1);
}
`;

// Check if kh and $i are already defined in the extract
let finalPreamble = preamble;
if (gameCode.includes('kh=')) finalPreamble = finalPreamble.replace(/var kh.*?;/, '');
if (gameCode.includes('$i=')) finalPreamble = finalPreamble.replace(/var \$i.*?;/, '');

// Also need Bf (difficulty table) if referenced
// Search for Bf in the code
const bfIdx = js.indexOf('Bf=[', Math.max(0, start - 5000));
let bfCode = '';
if (bfIdx >= 0 && bfIdx < start) {
  let bfEnd = js.indexOf('];', bfIdx) + 2;
  bfCode = js.substring(bfIdx, bfEnd) + ';\n';
  console.error(`Also extracted Bf array (${bfEnd - bfIdx} chars)`);
}

const fullCode = finalPreamble + bfCode + gameCode + postCode;

// Write to temp file and eval
const tmpFile = '/tmp/kenzo_level_gen.js';
fs.writeFileSync(tmpFile, fullCode);
console.error(`Wrote ${fullCode.length} chars to ${tmpFile}`);

// Run it
const { execSync } = require('child_process');
try {
  const output = execSync(`node ${tmpFile} ${seed} ${gate}`, {
    timeout: 10000,
    encoding: 'utf8'
  });
  console.log(output);
} catch(e) {
  console.error('Execution failed:', e.stderr || e.message);
  // Try to debug - show first error
  try {
    const debugOut = execSync(`node -e "try{require('${tmpFile}')}catch(e){console.error(e.message)}"`, {
      timeout: 5000, encoding: 'utf8'
    });
    console.error('Debug:', debugOut);
  } catch(e2) {}
  process.exit(1);
}
