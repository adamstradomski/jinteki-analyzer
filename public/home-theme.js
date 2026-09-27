// Applies the saved theme family and mode before first paint (the page's CSP forbids inline scripts),
// then mounts the theme controls once the header exists.
window.JW.initTheme();
document.addEventListener('DOMContentLoaded', () => {
  window.JW.mountThemeSwitcher(document.getElementById('theme-switcher'));
  window.JW.mountModeToggle(document.getElementById('mode-toggle'));
});
