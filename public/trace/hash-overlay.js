// Runs before the rest of the page's markup/script, so this is up at
// first paint for anyone arriving via a share or bookmarklet link
// (#log=...) rather than after the normal page has already rendered.
if (location.hash.startsWith('#log=')) document.getElementById('hashLoadOverlay').style.display = 'flex';
