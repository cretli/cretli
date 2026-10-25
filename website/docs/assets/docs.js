(function () {
  var root = document.documentElement;
  var themeBtn = document.querySelector('.theme-toggle');
  var navBtn = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  var search = /** @type {HTMLInputElement | null} */ (document.querySelector('.search'));
  var results = /** @type {HTMLElement | null} */ (document.querySelector('.search-results'));

  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set) return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('cretli-docs-theme', next); } catch (_e) { /* storage unavailable */ }
    });
  }

  if (navBtn && nav) {
    navBtn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      navBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  if (!search || !results) return;
  var index = null;

  function render(query) {
    var q = query.trim().toLowerCase();
    results.textContent = '';
    results.hidden = !q;
    if (!q || !index) return;
    index.forEach(function (page) {
      var hay = [page.title, page.description].concat(page.headings.map(function (h) { return h.text; })).join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = page.slug + '.html';
      a.textContent = page.title;
      li.appendChild(a);
      results.appendChild(li);
    });
    if (!results.firstChild) {
      var none = document.createElement('li');
      none.textContent = 'No results';
      results.appendChild(none);
    }
  }

  fetch('search-index.json')
    .then(function (r) { if (!r.ok) throw new Error('search index'); return r.json(); })
    .then(function (data) {
      index = data;
      search.hidden = false;
      search.addEventListener('input', function () { render(search.value); });
    })
    .catch(function () { search.hidden = true; });
})();
