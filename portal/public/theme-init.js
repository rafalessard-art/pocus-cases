// Apply the saved/system theme before first paint (same key as the public site).
try {
  var t = localStorage.getItem('pocus-theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
} catch (e) {}
