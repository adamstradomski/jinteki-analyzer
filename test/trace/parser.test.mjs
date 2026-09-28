// Golden tests for Trace's log parser (public/trace/parser.js).
//
// Every test/*.log and both built-in example logs (public/trace/examples.js)
// are parsed, and parseLog()'s output plus the achievements it earns must
// match test/trace/golden/<name>.json exactly. Run with:
//   node --test test/trace/*.test.mjs
// When a parser change is meant to change the output, regenerate the golden
// files with UPDATE_GOLDEN=1 and review the diff before committing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRACE = path.join(ROOT, 'public/trace');
const GOLDEN = path.join(ROOT, 'test/trace/golden');

// Browser globals parser.js must never touch. Each one is a getter that
// records the access (and then fails), so a stray reference is reported
// even if the parser catches the error.
const BROWSER_GLOBALS = ['window', 'document', 'navigator', 'location', 'localStorage',
  'sessionStorage', 'fetch', 'XMLHttpRequest', 'JW', 'alert', 'history', 'self'];

// Runs a classic script the way a <script> tag would, in a fresh context
// that has only the JavaScript built-ins plus the traps above.
function loadClassicScript(file, touched = []){
  const sandbox = {};
  for (const name of BROWSER_GLOBALS){
    Object.defineProperty(sandbox, name, {
      get(){ touched.push(name); throw new Error(`${path.basename(file)} accessed ${name}`); }
    });
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context;
}

// Key-sorted copy, so the JSON doesn't depend on property insertion order.
function canonical(value){
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object'){
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function goldenJson(parser, text){
  const data = parser.parseLog(text);
  const earned = parser.evaluateAchievements(data);
  const achievements = {};
  for (const player of Object.keys(earned)) achievements[player] = earned[player].map(a => a.name);
  // The JSON round trip drops what JSON can't hold (functions, undefined) the
  // same way for the live result and the stored file.
  const plain = JSON.parse(JSON.stringify({ parseLog: data, achievements }));
  return JSON.stringify(canonical(plain), null, 1) + '\n';
}

function goldenInputs(){
  const examples = loadClassicScript(path.join(TRACE, 'examples.js')).TRACE_EXAMPLES;
  const inputs = { 'example-1': examples.example1, 'example-2': examples.example2 };
  const logs = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.log')).sort();
  for (const f of logs) inputs[f.replace(/\.log$/, '')] = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
  return inputs;
}

const touched = [];
const parser = loadClassicScript(path.join(TRACE, 'parser.js'), touched).TraceParser;
const inputs = goldenInputs();

test('parser.js exposes TraceParser', () => {
  assert.equal(typeof parser, 'object');
  assert.equal(typeof parser.parseLog, 'function');
  assert.equal(typeof parser.evaluateAchievements, 'function');
});

test('every golden input has a golden file and vice versa', () => {
  const goldens = fs.readdirSync(GOLDEN).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
  if (process.env.UPDATE_GOLDEN === '1') return;
  assert.deepEqual(goldens, Object.keys(inputs).sort());
});

for (const [name, text] of Object.entries(inputs)){
  test(`parseLog output matches golden: ${name}`, () => {
    const actual = goldenJson(parser, text);
    const file = path.join(GOLDEN, name + '.json');
    if (process.env.UPDATE_GOLDEN === '1'){
      fs.writeFileSync(file, actual);
      return;
    }
    const expected = fs.readFileSync(file, 'utf8');
    // Compare parsed objects first for a readable diff, then the exact text.
    assert.deepEqual(JSON.parse(actual), JSON.parse(expected));
    assert.equal(actual, expected);
  });
}

test('parseLog is deterministic', () => {
  const [name, text] = Object.entries(inputs)[0];
  assert.equal(goldenJson(parser, text), goldenJson(parser, text), name);
});

test('parser.js never touches the DOM or other browser APIs', () => {
  // Loading and parsing every input above ran with trapped browser globals.
  for (const text of Object.values(inputs)) parser.parseLog(text);
  assert.deepEqual(touched, []);
  // And a source-level check, for code paths the inputs didn't reach.
  const source = fs.readFileSync(path.join(TRACE, 'parser.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const found = BROWSER_GLOBALS.filter(name => new RegExp(String.raw`(?<![\w.$'"])${name}\s*[.([]`).test(source));
  assert.deepEqual(found, []);
});
