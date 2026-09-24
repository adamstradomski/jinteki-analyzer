// Site build step: fills build-time values into index.html so they are not
// committed to the public repo. Production and preview builds get different
// values from the Worker's build variables (Settings → Build).
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../index.html', import.meta.url);
const url = process.env.SHORTEN_API_URL;
if (!url || !/^https:\/\/[^\s"'<>\\]+$/.test(url)) {
  console.error('SHORTEN_API_URL build variable is missing or not an https URL');
  process.exit(1);
}
const html = readFileSync(file, 'utf8');
if (!html.includes('__SHORTEN_API_URL__')) {
  console.error('Placeholder __SHORTEN_API_URL__ not found in index.html');
  process.exit(1);
}
writeFileSync(file, html.replaceAll('__SHORTEN_API_URL__', url));
console.log('index.html: SHORTEN_API_URL injected');
