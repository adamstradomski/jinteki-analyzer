// Number and date formatters for the Market Research page. Pure: no DOM, so Node tests import them.

const nf = new Intl.NumberFormat('en-GB');
export const MINUS = '−';
export const fmtInt = (v) => (v === null || v === undefined ? '–' : nf.format(v));
export const fmtN = (v) => `n=${fmtInt(v)}`;
export const fmtPct = (v, d = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(d)}%`);
const sign = (v, d) => (v > 0 ? '+' : v < 0 ? MINUS : '±') + Math.abs(v).toFixed(d);
export const fmtPp = (v, d = 1) => (v === null || v === undefined ? '–' : `${sign(v, d)} pp`);
export const fmtRatio = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(2)}×`);
export const fmtNum = (v, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d));
export const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const shortMonth = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
