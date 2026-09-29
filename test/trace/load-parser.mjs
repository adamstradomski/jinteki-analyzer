// Loads Trace's classic scripts (public/trace/parser.js, examples.js) the way a <script> tag would,
// in a fresh context. Objects they return belong to that context, so compare them after plain()
// (a JSON round trip): deepStrictEqual also compares prototypes, which differ between contexts.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PARSER = new URL('../../public/trace/parser.js', import.meta.url);

// Browser globals parser.js must never touch. Each one is a getter that
// records the access (and then fails), so a stray reference is reported
// even if the parser catches the error.
export const BROWSER_GLOBALS = ['window', 'document', 'navigator', 'location', 'localStorage',
  'sessionStorage', 'fetch', 'XMLHttpRequest', 'JW', 'alert', 'history', 'self'];

// Runs a classic script in a fresh context that has only the JavaScript
// built-ins plus the traps above. Trapped names are pushed to `touched`.
export function loadClassicScript(file, touched = []){
  const sandbox = {};
  for (const name of BROWSER_GLOBALS){
    Object.defineProperty(sandbox, name, {
      get(){ touched.push(name); throw new Error(`${path.basename(String(file))} accessed ${name}`); }
    });
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: String(file) });
  return context;
}

// globalThis.TraceParser from a fresh copy of parser.js.
export function loadParser(touched = []){
  return loadClassicScript(PARSER, touched).TraceParser;
}

export const plain = (value) => JSON.parse(JSON.stringify(value));
