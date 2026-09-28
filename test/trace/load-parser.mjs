// Loads public/trace/parser.js the way a <script> tag would, in a fresh context, and returns its
// globalThis.TraceParser. Objects it returns belong to that context, so compare them after plain()
// (a JSON round trip): deepStrictEqual also compares prototypes, which differ between contexts.
import fs from 'node:fs';
import vm from 'node:vm';

const PARSER = new URL('../../public/trace/parser.js', import.meta.url);

export function loadParser(){
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(PARSER, 'utf8'), context, { filename: 'parser.js' });
  return context.TraceParser;
}

export const plain = (value) => JSON.parse(JSON.stringify(value));
