#!/usr/bin/env node
/**
 * Extract level layout from KenzoCoin game JS.
 * Runs the actual level generator to get exact checkpoint and finish positions.
 * Usage: node kenzo_level_extract.js <seed> [gate]
 */

const fs = require('fs');

const seedArg = parseInt(process.argv[2] || '0');
const gateArg = parseInt(process.argv[3] || '0');

if (!seedArg) {
  console.error('Usage: node kenzo_level_extract.js <seed> [gate]');
  process.exit(1);
}

// Read the game JS
const jsPath = '/tmp/kenzo_app.js';
if (!fs.existsSync(jsPath)) {
  console.error('Download first: curl -o /tmp/kenzo_app.js "https://kenzocoin.meme/v2/play/app.js?v=80137626"');
  process.exit(1);
}

const js = fs.readFileSync(jsPath, 'utf8');

// Find key code sections
const gyIdx = js.indexOf('function gy(');
const hhEndMarker = 'r.dizzy=r.els.filter(c=>c.k==="dizzy"),r.gravs=r.els.filter(c=>c.k==="grav"),r}';
const hhEnd = js.indexOf(hhEndMarker);

if (gyIdx < 0 || hhEnd < 0) {
  console.error('Could not find level generator functions');
  process.exit(1);
}

const codeEnd = hhEnd + hhEndMarker.length;

// Find Gf array
let gfIdx = js.indexOf('Gf=[', gyIdx);
if (gfIdx < 0) {
  console.error('Could not find Gf array');
  process.exit(1);
}

// Find matching closing bracket
let depth = 0, gfEnd = gfIdx;
for (let i = js.indexOf('[', gfIdx); i < js.length; i++) {
  if (js[i] === '[') depth++;
  else if (js[i] === ']') {
    depth--;
    if (depth === 0) { gfEnd = i + 1; break; }
  }
}

// Also find Bf (difficulty table) if it exists before our code
let bfCode = '';
const bfSearch = js.lastIndexOf('Bf=[', gyIdx);
if (bfSearch >= 0) {
  const bfEndIdx = js.indexOf('];', bfSearch) + 2;
  bfCode = 'var ' + js.substring(bfSearch, bfEndIdx) + ';\n';
  console.error(`Bf: ${bfSearch}-${bfEndIdx}`);
}

// Also find _y function (difficulty scaler)
let dyCode = '';
const dySearch = js.indexOf('function _y(');
if (dySearch >= 0 && dySearch < codeEnd) {
  // _y is within the extracted range, good
} else if (dySearch >= 0) {
  // Need to include it separately
  let dyEnd = dySearch;
  let dd = 0;
  for (let i = js.indexOf('{', dySearch); i < js.length; i++) {
    if (js[i] === '{') dd++;
    else if (js[i] === '}') {
      dd--;
      if (dd === 0) { dyEnd = i + 1; break; }
    }
  }
  dyCode = js.substring(dySearch, dyEnd) + '\n';
  console.error(`_y: ${dySearch}-${dyEnd}`);
}

const start = Math.min(gyIdx, gfIdx);
const end = Math.max(codeEnd, gfEnd);
console.error(`Game code: ${start}-${end} (${end-start} chars)`);

// Build the executable code
const gameCode = js.substring(start, end);

// Create a self-contained script
const fullCode = `
// Stubs for missing globals
var Ae = Math.PI * 2;
${bfCode}
${dyCode}
${gameCode}

// Run level generator
try {
  var level = Hh(${gateArg}, ${seedArg});
  var result = {
    gate: ${gateArg},
    seed: ${seedArg},
    name: level.name,
    finishZ: level.finishZ,
    gateZ: level.gateZ,
    end: level.end,
    sweep: level.sweep,
    y: level.y,
    checkpoints: level.cps,
    segments: level.segs,
    platforms: level.els.filter(function(e){return e.k==='box'}).map(function(e){
      return {x:e.x,z:e.z,w:e.w,d:e.d,top:e.top||0,h:e.h||1,style:e.style,cp:!!e.cp,trap:e.trap,fake:e.fake};
    }),
    gold: level.els.filter(function(e){return e.style==='gold'&&!e.trap}).map(function(e){
      return {x:e.x,z:e.z,w:e.w,d:e.d,top:e.top||0};
    })
  };
  process.stdout.write(JSON.stringify(result, null, 2));
} catch(err) {
  process.stderr.write('Level gen error: ' + err.message + '\\n' + err.stack + '\\n');
  process.exit(1);
}
`;

const tmpFile = '/tmp/kenzo_level_gen.js';
fs.writeFileSync(tmpFile, fullCode);
console.error(`Wrote ${fullCode.length} chars to ${tmpFile}`);

// Execute
const { execSync } = require('child_process');
try {
  const output = execSync(`node ${tmpFile}`, {
    timeout: 10000,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  console.log(output);
} catch(e) {
  console.error('Exec failed:');
  if (e.stderr) console.error(e.stderr.substring(0, 2000));
  if (e.stdout) console.log(e.stdout.substring(0, 500));
  process.exit(1);
}
