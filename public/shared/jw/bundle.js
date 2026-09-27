(function () {
  /* Four theme families, each with a dark and a light mode.
     The page carries one attribute: data-theme="<family>" (dark) or "<family>-light" (light),
     plus data-mode="dark|light" for convenience. */
  var FAMILIES = [
    { id: 'jnet', name: 'Beanstalk' },
    { id: 'icewall', name: 'Ice Wall' },
    { id: 'console', name: 'Console' },
    { id: 'nightcity', name: 'Night City' }
  ];
  var MODES = ['dark', 'light'];
  var THEME_KEY = 'jw-theme';
  var MODE_KEY = 'jw-mode';
  var IDS = FAMILIES.map(function (f) { return f.id; });

  function isFamily(id) { return IDS.indexOf(id) !== -1; }
  function isMode(m) { return MODES.indexOf(m) !== -1; }
  function read(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, v) { try { window.localStorage.setItem(key, v); } catch (e) {} }
  function systemMode() {
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  /* Accepts "icewall" or "icewall-light"; returns { family, mode }. */
  function parse(value) {
    var v = String(value || '');
    var light = /-light$/.test(v);
    var fam = light ? v.slice(0, -6) : v;
    return { family: isFamily(fam) ? fam : null, mode: light ? 'light' : (isFamily(fam) ? 'dark' : null) };
  }

  function current() {
    var p = parse(document.documentElement.getAttribute('data-theme'));
    if (p.family) return p;
    var f = read(THEME_KEY), m = read(MODE_KEY);
    return { family: isFamily(f) ? f : 'jnet', mode: isMode(m) ? m : systemMode() };
  }

  function apply(family, mode, persist) {
    var root = document.documentElement;
    root.setAttribute('data-theme', family + (mode === 'light' ? '-light' : ''));
    root.setAttribute('data-mode', mode);
    if (persist !== false) { write(THEME_KEY, family); write(MODE_KEY, mode); }
    document.dispatchEvent(new CustomEvent('jw:themechange', { detail: { family: family, mode: mode, theme: root.getAttribute('data-theme') } }));
    return { family: family, mode: mode };
  }

  function getTheme() { return current().family; }
  function getMode() { return current().mode; }

  /* setTheme('icewall') keeps the current mode; setTheme('icewall-light') sets both. */
  function setTheme(value, opts) {
    var p = parse(value), cur = current();
    var family = p.family || 'jnet';
    var mode = /-light$/.test(String(value)) ? 'light' : cur.mode;
    return apply(family, mode, !opts || opts.persist !== false);
  }
  function setMode(mode, opts) {
    return apply(current().family, isMode(mode) ? mode : 'dark', !opts || opts.persist !== false);
  }
  function toggleMode() { return setMode(getMode() === 'light' ? 'dark' : 'light'); }

  /* Call once, as early as possible (inline in <head>), to avoid a flash of the wrong theme.
     With no saved mode it follows the system setting. */
  function initTheme() {
    var f = read(THEME_KEY), m = read(MODE_KEY);
    var legacy = parse(f);
    if (legacy.family && /-light$/.test(f)) { f = legacy.family; m = 'light'; }
    return apply(isFamily(f) ? f : 'jnet', isMode(m) ? m : systemMode(), false);
  }

  /* Four family buttons (Beanstalk, Ice Wall, Console, Night City). */
  function mountThemeSwitcher(el) {
    if (!el) return null;
    el.classList.add('theme-switcher');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Theme');
    el.textContent = '';
    var buttons = FAMILIES.map(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = f.name;
      b.setAttribute('data-family', f.id);
      b.addEventListener('click', function () { setTheme(f.id); });
      el.appendChild(b);
      return b;
    });
    function sync() {
      var fam = getTheme();
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-family') === fam)); });
    }
    document.addEventListener('jw:themechange', sync);
    sync();
    return { sync: sync, destroy: function () { document.removeEventListener('jw:themechange', sync); } };
  }

  /* One switch: Dark | Light. aria-checked="true" means light. */
  var MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg>';
  var SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>';
  function mountModeToggle(el) {
    if (!el) return null;
    var btn = el.tagName === 'BUTTON' ? el : document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-toggle';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-label', 'Light mode');
    btn.innerHTML = '<span class="mode-opt mode-dark">' + MOON + 'Dark</span><span class="mode-opt mode-light">' + SUN + 'Light</span>';
    if (btn !== el) { el.textContent = ''; el.appendChild(btn); }
    btn.addEventListener('click', toggleMode);
    function sync() { btn.setAttribute('aria-checked', String(getMode() === 'light')); }
    document.addEventListener('jw:themechange', sync);
    sync();
    return { sync: sync, destroy: function () { document.removeEventListener('jw:themechange', sync); } };
  }

  /* Corp / Runner toggle. onChange(side) fires on click. */
  function mountSideToggle(el, side, onChange) {
    if (!el) return null;
    el.classList.add('side-toggle');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Side');
    el.textContent = '';
    var cur = side === 'runner' ? 'runner' : 'corp';
    var btns = ['corp', 'runner'].map(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = s;
      b.textContent = s === 'corp' ? 'Corp' : 'Runner';
      b.addEventListener('click', function () { cur = s; sync(); if (onChange) onChange(s); });
      el.appendChild(b);
      return b;
    });
    function sync() { btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.className === cur)); }); }
    sync();
    return { get: function () { return cur; }, set: function (s) { cur = s; sync(); } };
  }

  /* Resolved colours for SVG/canvas charts: SVG presentation attributes cannot read var(). */
  function tokenValue(name, el) {
    return getComputedStyle(el || document.documentElement).getPropertyValue('--' + name).trim();
  }
  function chartColors(el) {
    var out = [];
    for (var i = 1; i <= 6; i++) out.push(tokenValue('chart-' + i, el));
    return out;
  }
  function sideColor(side, el) { return tokenValue(side === 'runner' ? 'runner' : 'corp', el); }

  /* Makes every .panel-header with a .collapse-icon toggle its panel. */
  function enablePanelCollapse(root) {
    (root || document).querySelectorAll('.panel').forEach(function (p) {
      var btn = p.querySelector('.panel-header .collapse-icon');
      var body = p.querySelector('.panel-body');
      if (!btn || !body) return;
      btn.setAttribute('aria-expanded', 'true');
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(open));
        body.hidden = !open;
        btn.textContent = open ? '−' : '+';
      });
    });
  }

  window.JW = {
    families: FAMILIES,
    themes: FAMILIES,
    modes: MODES,
    initTheme: initTheme,
    getTheme: getTheme,
    setTheme: setTheme,
    getMode: getMode,
    setMode: setMode,
    toggleMode: toggleMode,
    mountThemeSwitcher: mountThemeSwitcher,
    mountModeToggle: mountModeToggle,
    mountSideToggle: mountSideToggle,
    enablePanelCollapse: enablePanelCollapse,
    tokenValue: tokenValue,
    chartColors: chartColors,
    sideColor: sideColor
  };
})();
