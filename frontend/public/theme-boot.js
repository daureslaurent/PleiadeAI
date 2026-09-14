// Loaded as a file, not inlined in index.html: the production CSP is `script-src 'self'`, which
// blocks inline scripts — inlined, this never ran on prod and every load flashed the default theme.
// Stamp the stored theme before the bundle loads, or the first paint is Pleiades and the
// real theme arrives as a flash. Duplicates src/theme/apply.ts on purpose: this has to run
// without a module, and it also themes the login screen, which renders before any API call.
// Kept deliberately tiny — the id and the two facts the first paint needs, nothing more.
(function () {
  var MODES = { pleiades: 'dark', codex: 'light', terminal: 'dark', paper: 'light', nebula: 'dark' };
  var CHROME = { pleiades: '#0f1419', codex: '#ffffff', terminal: '#07090b', paper: '#faf7f2', nebula: '#0e0a1c' };
  var id = 'pleiades';
  try {
    var raw = localStorage.getItem('pleiades.prefs.v1');
    var stored = raw && JSON.parse(raw).theme;
    if (stored && MODES[stored]) id = stored;
  } catch (e) {
    /* private mode / storage disabled — the default is already correct */
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', id);
  root.classList.toggle('dark', MODES[id] === 'dark');
  root.style.colorScheme = MODES[id];
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME[id]);
})();
