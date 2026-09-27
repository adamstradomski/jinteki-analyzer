(function () {
  var THEMES = [
    { id: 'jnet', name: 'jinteki.win' },
    { id: 'icewall', name: 'Ice Wall' },
    { id: 'console', name: 'Console' },
    { id: 'nightcity', name: 'Night City' }
  ];
  var KEY = 'jw-theme';
  var IDS = THEMES.map(function (t) { return t.id; });

  function isTheme(id) { return IDS.indexOf(id) !== -1; }

  function getTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    if (isTheme(cur)) return cur;
    try { var saved = window.localStorage.getItem(KEY); if (isTheme(saved)) return saved; } catch (e) {}
    return 'jnet';
  }

  function setTheme(id, opts) {
    if (!isTheme(id)) id = 'jnet';
    document.documentElement.setAttribute('data-theme', id);
    if (!opts || opts.persist !== false) { try { window.localStorage.setItem(KEY, id); } catch (e) {} }
    document.dispatchEvent(new CustomEvent('jw:themechange', { detail: { theme: id } }));
    return id;
  }

  /* Call once, as early as possible (inline in <head>), to avoid a flash of the default theme. */
  function initTheme() {
    var id = 'jnet';
    try { var saved = window.localStorage.getItem(KEY); if (isTheme(saved)) id = saved; } catch (e) {}
    document.documentElement.setAttribute('data-theme', id);
    return id;
  }

  /* Renders four pressed-state buttons into `el` and keeps them in sync. */
  function mountThemeSwitcher(el) {
    if (!el) return null;
    el.classList.add('theme-switcher');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Theme');
    el.textContent = '';
    var buttons = THEMES.map(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.name;
      b.setAttribute('data-theme-id', t.id);
      b.addEventListener('click', function () { setTheme(t.id); });
      el.appendChild(b);
      return b;
    });
    function sync() {
      var cur = getTheme();
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-id') === cur)); });
    }
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
    var current = side === 'runner' ? 'runner' : 'corp';
    var btns = ['corp', 'runner'].map(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = s;
      b.textContent = s === 'corp' ? 'Corp' : 'Runner';
      b.addEventListener('click', function () { current = s; sync(); if (onChange) onChange(s); });
      el.appendChild(b);
      return b;
    });
    function sync() { btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.className === current)); }); }
    sync();
    return { get: function () { return current; }, set: function (s) { current = s; sync(); } };
  }

  /* Resolved colors for SVG/canvas charts: SVG presentation attributes cannot read var(). */
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
    themes: THEMES,
    initTheme: initTheme,
    getTheme: getTheme,
    setTheme: setTheme,
    mountThemeSwitcher: mountThemeSwitcher,
    mountSideToggle: mountSideToggle,
    enablePanelCollapse: enablePanelCollapse,
    tokenValue: tokenValue,
    chartColors: chartColors,
    sideColor: sideColor
  };
})();
