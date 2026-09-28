// The log analyzer used to live at / and now lives at /trace/. Share links
// (https://jinteki.win/#log=…), bookmarklets people already installed, and
// short links still cached with the old redirect all land here, so forward
// them with the log intact. Loaded before the stylesheets so nothing paints first.
if (location.hash.startsWith('#log=')) {
  location.replace((location.protocol === 'file:' ? 'trace/index.html' : 'trace/') + location.hash);
}
