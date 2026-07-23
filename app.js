'use strict';

/* =========================================================================
   Geely Accessories Catalog — application logic
   Split out of the original single-file HTML into index.html / styles.css /
   app.js / data.json / images/*.webp for maintainability and performance.
   ========================================================================= */

// ---------------- Supabase client ----------------
const sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

// ---------------- Security helpers ----------------

// Escapes any string before it is inserted into innerHTML, so product
// names/descriptions/codes coming from the database (or from an imported
// JSON file) can never inject markup or scripts (XSS protection).
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Basic guard against obviously-dangerous data URIs / URLs being stored as
// an "image". We only ever accept data:image/* URIs (from <input type=file>)
// or our own local webp paths — never http(s) URLs or javascript: URIs.
function isSafeImageSrc(src) {
  if (!src) return true; // no image is fine
  if (typeof src !== 'string') return false;
  return /^data:image\/(png|jpe?g|webp|gif);base64,/.test(src) || /^images\//.test(src);
}

function clampNumber(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// ---------------- Data (catalog labels + one-time seed shape) ----------------
const CATS = {
  charging: { label: 'טעינה וחשמל', color: '#3b5bff' },
  multimedia: { label: 'מולטימדיה ואבטחה', color: '#8b2ff0' },
  protection: { label: 'הגנה ואחסון', color: '#ff3ea5' },
  styling: { label: 'עיצוב ומיתוג', color: '#2fbf9a' },
  services: { label: 'שירותים', color: '#f0a53a' },
};
const KNOWN_CATS = Object.keys(CATS);
const KNOWN_MODELS = ['both', 'starray', 'ex5'];
const HERO_NAME = { starray: 'STARRAY EM-i', ex5: 'EX5' };

let PRODUCTS = [];
let BUNDLES = [];
let SITE_CONTENT = null; // filled from data.json (seed) then Supabase (source of truth)
let SEED_CONTENT = null; // the local seed, used only to populate an empty DB

let state = { model: 'starray', cat: 'all', q: '' };

// ---------------- UI helpers: loading / error / toast ----------------
function setLoading(isLoading) {
  document.getElementById('appLoading').hidden = !isLoading;
}

function showError(message) {
  const banner = document.getElementById('errorBanner');
  document.getElementById('errorBannerText').textContent = message;
  banner.hidden = false;
}
function hideError() {
  document.getElementById('errorBanner').hidden = true;
}
document.getElementById('errorBannerClose').addEventListener('click', hideError);

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------- Data conversion (app shape <-> db row shape) ----------------
function toDbProduct(p) {
  return {
    code: p.code, name: p.name, price: p.price, discount: p.discount || 0,
    model: p.model, cat: p.cat, description: p.desc || '',
    img_sr: p.img_sr || null, img_ex: p.img_ex || null, blocked: !!p.blocked,
  };
}
function fromDbProduct(row) {
  return {
    code: row.code, name: row.name, price: row.price, discount: row.discount || 0,
    model: row.model, cat: row.cat, desc: row.description || '',
    img_sr: row.img_sr, img_ex: row.img_ex, blocked: !!row.blocked,
  };
}
function toDbBundle(b) {
  return {
    code: b.code, name: b.name, price: b.price, old_price: b.old_price || null,
    model: b.model, items: b.items, img: b.img || null,
  };
}
function fromDbBundle(row) {
  return { code: row.code, name: row.name, price: row.price, old_price: row.old_price, model: row.model, items: row.items || [], img: row.img || null };
}

// ---------------- Validation ----------------
// Every write path (manual form + JSON import) goes through these
// validators, so bad or malicious data can never reach Supabase or the DOM.
function validateProduct(p) {
  const errors = [];
  const code = String(p.code || '').trim();
  const name = String(p.name || '').trim();
  const price = Number(p.price);
  const discount = p.discount ? Number(p.discount) : 0;
  const model = KNOWN_MODELS.includes(p.model) ? p.model : null;
  const cat = KNOWN_CATS.includes(p.cat) ? p.cat : null;
  const desc = String(p.desc || '').slice(0, 400);

  if (!code || code.length > 40) errors.push('מק"ט חסר או ארוך מדי');
  if (!name || name.length > 120) errors.push('שם חסר או ארוך מדי');
  if (Number.isNaN(price) || price < 0 || price > 1000000) errors.push('מחיר לא תקין');
  if (discount < 0 || discount > 95) errors.push('אחוז הנחה לא תקין');
  if (!model) errors.push('דגם לא תקין');
  if (!cat) errors.push('קטגוריה לא תקינה');
  if (!isSafeImageSrc(p.img_sr) || !isSafeImageSrc(p.img_ex)) errors.push('תמונה לא תקינה');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { code, name, price, discount, model, cat, desc, img_sr: p.img_sr || null, img_ex: p.img_ex || null, blocked: !!p.blocked },
  };
}

function validateBundle(b) {
  const errors = [];
  const code = String(b.code || '').trim();
  const name = String(b.name || '').trim();
  const price = Number(b.price);
  const old_price = b.old_price ? Number(b.old_price) : null;
  const model = ['starray', 'ex5'].includes(b.model) ? b.model : null;
  const items = Array.isArray(b.items) ? b.items.map((i) => String(i).trim()).filter(Boolean).slice(0, 40) : [];

  if (!code || code.length > 40) errors.push('מק"ט חסר או ארוך מדי');
  if (!name || name.length > 120) errors.push('שם חסר או ארוך מדי');
  if (Number.isNaN(price) || price < 0 || price > 1000000) errors.push('מחיר לא תקין');
  if (old_price !== null && (Number.isNaN(old_price) || old_price < 0)) errors.push('מחיר קודם לא תקין');
  if (!model) errors.push('דגם לא תקין');
  if (!items.length) errors.push('יש להוסיף לפחות אביזר אחד לחבילה');
  if (!isSafeImageSrc(b.img)) errors.push('תמונה לא תקינה');

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { code, name, price, old_price, model, items, img: b.img || null } };
}

// ---------------- Load seed shape from local data.json ----------------
async function loadSeed() {
  const res = await fetch('data.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('data.json ' + res.status);
  const data = await res.json();
  SEED_CONTENT = data;
  return data;
}

// ---------------- Load current data from Supabase (single source of truth) ----------------
async function loadProductsFromSupabase() {
  const { data, error } = await sb.from('accessories').select('*');
  if (error) throw error;
  if (data && data.length) {
    PRODUCTS = data.map(fromDbProduct);
  } else {
    // DB is empty (first run) — seed it once from the local seed file.
    PRODUCTS = SEED_CONTENT.products.slice();
    if (PRODUCTS.length) {
      const { error: seedErr } = await sb.from('accessories').insert(PRODUCTS.map(toDbProduct));
      if (seedErr) console.error('Seeding accessories failed', seedErr);
    }
  }
}

async function loadBundlesFromSupabase() {
  const { data, error } = await sb.from('bundles').select('*');
  if (error) throw error;
  if (data && data.length) {
    BUNDLES = data.map(fromDbBundle);
  } else {
    BUNDLES = SEED_CONTENT.bundles.slice();
    if (BUNDLES.length) {
      const { error: seedErr } = await sb.from('bundles').insert(BUNDLES.map(toDbBundle));
      if (seedErr) console.error('Seeding bundles failed', seedErr);
    }
  }
}

async function loadSiteContentFromSupabase() {
  SITE_CONTENT = JSON.parse(JSON.stringify(SEED_CONTENT.site_content));
  const { data, error } = await sb.from('site_content').select('value').eq('key', 'main').maybeSingle();
  if (error) throw error;
  if (data && data.value) {
    const saved = data.value;
    Object.assign(SITE_CONTENT, saved, { models: Object.assign(SITE_CONTENT.models, saved.models || {}) });
  } else {
    const { error: seedErr } = await sb.from('site_content').insert({ key: 'main', value: SITE_CONTENT });
    if (seedErr) console.error('Seeding site_content failed', seedErr);
  }
}

async function persistSiteContent() {
  try {
    const { error } = await sb.from('site_content').upsert({ key: 'main', value: SITE_CONTENT });
    if (error) throw error;
  } catch (err) {
    console.error('Failed to save site content', err);
    showError('שמירת תוכן העמוד נכשלה: ' + (err.message || 'שגיאת שרת'));
  }
}

// ---------------- URL <-> state (shareable links) ----------------
function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const model = params.get('model');
  const cat = params.get('cat');
  const q = params.get('q');
  if (model && HERO_NAME[model]) state.model = model;
  if (cat && (cat === 'all' || cat === 'bundles' || KNOWN_CATS.includes(cat))) state.cat = cat;
  if (q) state.q = q;
  return !!model; // whether we should skip the splash screen
}

function syncStateToUrl() {
  const params = new URLSearchParams();
  params.set('model', state.model);
  if (state.cat !== 'all') params.set('cat', state.cat);
  if (state.q) params.set('q', state.q);
  const newUrl = `${location.pathname}?${params.toString()}${location.hash}`;
  history.replaceState(null, '', newUrl);
}

document.getElementById('shareBtn').addEventListener('click', async () => {
  syncStateToUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('הקישור הועתק ללוח');
  } catch {
    showToast(location.href);
  }
});

// ---------------- Rendering ----------------
function fmtPrice(n) { return '&#8362;' + Number(n).toLocaleString('he-IL'); }

function applySplashText() {
  document.getElementById('splashEyebrowText').textContent = SITE_CONTENT.splash.eyebrow;
  document.getElementById('splashTitleText').textContent = SITE_CONTENT.splash.title;
  document.getElementById('splashSubText').textContent = SITE_CONTENT.splash.sub;
  document.querySelectorAll('.splash-cta').forEach((el) => { el.textContent = SITE_CONTENT.splash.cta; });
}

function applyHero() {
  const m = SITE_CONTENT.models[state.model];
  const name = HERO_NAME[state.model];
  document.getElementById('heroImg').src = m.img;
  const titleText = (m.title && m.title.trim()) || `אביזרי ${name} המקוריים`;
  let titleHtml = escapeHtml(titleText).replace(/\n/g, '<br>');
  const escName = escapeHtml(name);
  if (titleHtml.includes(escName)) {
    titleHtml = titleHtml.replace(escName, `<span class="modelname">${escName}</span>`);
  }
  document.getElementById('heroTitle').innerHTML = titleHtml;
  document.getElementById('heroText').textContent = m.text;
  document.getElementById('eyebrowText').textContent = SITE_CONTENT.eyebrow;
  document.getElementById('footerLine1').textContent = SITE_CONTENT.footer1;
  document.getElementById('footerLine2').textContent = SITE_CONTENT.footer2;
  document.querySelectorAll('#modelSwitch button').forEach((b) => {
    const active = b.dataset.model === state.model;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

function updateSplashImages() {
  document.getElementById('splashImgStarray').src = SITE_CONTENT.models.starray.img;
  document.getElementById('splashImgEx5').src = SITE_CONTENT.models.ex5.img;
}

function buildChips() {
  const row = document.getElementById('chipRow');
  const all = [{ k: 'all', label: 'הכל' }].concat(Object.entries(CATS).map(([k, v]) => ({ k, label: v.label })));
  all.push({ k: 'bundles', label: '📦 חבילות' });
  row.innerHTML = all.map((c) => `<button class="chip ${c.k === 'all' ? 'active' : ''} ${c.k === 'bundles' ? 'chip-bundles' : ''}" data-cat="${c.k}" aria-pressed="${c.k === state.cat}">${escapeHtml(c.label)}</button>`).join('');
  row.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      hideBundleReturnBanner();
      state.cat = btn.dataset.cat;
      state.q = '';
      document.getElementById('searchInput').value = '';
      row.querySelectorAll('.chip').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      syncStateToUrl();
      render();
    });
  });
}

function productImg(p) { return state.model === 'starray' ? p.img_sr : p.img_ex; }
function matchesModel(p) { return p.model === 'both' || p.model === state.model; }

// Best-effort match of a free-text bundle item line to an actual product,
// so we can show its live price on hover and link to it. If nothing
// matches (e.g. the line describes a service, not a catalog item) the
// item is rendered as plain text — never a broken/misleading link.
// Splits a product/bundle-item name into normalized comparison words:
// strips parenthetical suffixes like "(כבל סבתא)", lowercases, and splits
// on whitespace/commas/slashes.
// Hebrew catalog text sometimes writes a quantity as a digit ("3 חלקים")
// and sometimes spelled out ("שלושה חלקים") — normalize both to the same
// token so matching doesn't fail on that alone.
const HEBREW_NUMBER_MAP = {
  '1': 'אחד', 'אחד': 'אחד', 'אחת': 'אחד',
  '2': 'שתיים', 'שתיים': 'שתיים', 'שניים': 'שתיים', 'זוג': 'שתיים',
  '3': 'שלוש', 'שלושה': 'שלוש', 'שלוש': 'שלוש',
  '4': 'ארבע', 'ארבעה': 'ארבע',
  '5': 'חמש', 'חמישה': 'חמש',
  '6': 'שש', 'שישה': 'שש',
};

function nameWords(s) {
  const stripped = String(s || '').replace(/\([^)]*\)/g, ' ');
  return stripped.split(/[\s,/]+/).map((w) => {
    const clean = w.trim().toLowerCase();
    return HEBREW_NUMBER_MAP[clean] || clean;
  }).filter(Boolean);
}

// Matches a free-text bundle item line (often shorthand, e.g. "פס תאורה
// STARLED") to an actual catalog product (e.g. "פס תאורה קדמית STARLED").
// Strategy: exact normalized match first; otherwise the item's words (or
// the product's words) must be fully contained in the other — this catches
// shorthand/expanded variants without ever matching on a single stray word.
// If nothing matches, returns null and the item stays plain text.
function findMatchingProduct(itemText, bundleModel) {
  const itemWords = nameWords(itemText);
  if (!itemWords.length) return null;
  const candidates = PRODUCTS.filter((p) => p.model === 'both' || p.model === bundleModel);

  const itemNorm = itemWords.join(' ');
  const exact = candidates.find((p) => nameWords(p.name).join(' ') === itemNorm);
  if (exact) return exact;

  if (itemWords.length < 2) return null; // avoid matching on a single generic word
  const itemSet = new Set(itemWords);

  let best = null;
  let bestScore = 0;
  candidates.forEach((p) => {
    const pWords = nameWords(p.name);
    const pSet = new Set(pWords);
    const itemSubsetOfProduct = itemWords.every((w) => pSet.has(w));
    const productSubsetOfItem = pWords.every((w) => itemSet.has(w));
    if (!itemSubsetOfProduct && !productSubsetOfItem) return;
    const overlap = itemWords.filter((w) => pSet.has(w)).length;
    const score = overlap - Math.abs(itemSet.size - pSet.size) * 0.1;
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return best;
}

// Jumps the catalog view to a specific product (used by clickable bundle
// items) and opens its lightbox so the user sees the accessory itself.
// Remembers where the user was (bundles view, model, search text) right
// before clicking a linked accessory inside a bundle, so a "back to
// bundle" banner can restore that exact view with one click.
let bundleReturnState = null;

function goToProduct(code) {
  const p = PRODUCTS.find((x) => x.code === code);
  if (!p) return;
  bundleReturnState = { cat: state.cat, model: state.model, q: state.q };
  state.model = (p.model === 'both') ? state.model : p.model;
  state.cat = KNOWN_CATS.includes(p.cat) ? p.cat : 'all';
  state.q = p.code;
  document.getElementById('searchInput').value = p.code;
  applyHero();
  buildChips();
  syncStateToUrl();
  render();
  openLightbox(p.code);
  // Note: no "return to bundle" banner needed anymore — closing the
  // lightbox in any way (click outside, X, or Escape) restores the
  // bundle view automatically. See closeLightbox().
}

function hideBundleReturnBanner() {
  document.getElementById('bundleReturnBanner').hidden = true;
  bundleReturnState = null;
}

function returnToBundleView() {
  if (!bundleReturnState) return;
  state.cat = bundleReturnState.cat;
  state.model = bundleReturnState.model;
  state.q = bundleReturnState.q;
  document.getElementById('searchInput').value = state.q;
  applyHero();
  buildChips();
  syncStateToUrl();
  render();
  hideBundleReturnBanner();
}

// Kept for backward compatibility in case the banner button markup is
// ever re-shown; closing the lightbox now triggers the same behavior.
document.getElementById('bundleReturnBtn').addEventListener('click', () => {
  closeLightbox();
});

function render() {
  const grid = document.getElementById('grid');
  const q = state.q.trim().toLowerCase();
  document.getElementById('addFab').innerHTML = state.cat === 'bundles' ? '&#43; הוסף חבילה' : '&#43; הוסף אביזר';

  if (state.cat === 'bundles') {
    const list = BUNDLES.filter((b) => {
      if (b.model !== state.model) return false;
      if (q && !(b.name.toLowerCase().includes(q) || b.code.toLowerCase().includes(q) || b.items.join(' ').toLowerCase().includes(q))) return false;
      return true;
    });
    document.getElementById('resultCount').textContent = list.length + ' חבילות';
    grid.style.display = list.length ? 'grid' : 'none';
    document.getElementById('emptyState').style.display = list.length ? 'none' : 'block';

    grid.innerHTML = list.map((b, bi) => {
      const save = b.old_price && b.old_price > b.price ? Math.round(100 * (b.old_price - b.price) / b.old_price) : null;
      const adminOverlay = adminMode ? `
        <div class="card-admin-actions">
          <button class="icon-btn edit" data-bedit="${escapeHtml(b.code)}" aria-label="עריכת חבילה ${escapeHtml(b.name)}">&#9998;&#65039;</button>
          <button class="icon-btn del" data-bdel="${escapeHtml(b.code)}" aria-label="מחיקת חבילה ${escapeHtml(b.name)}">&#128465;&#65039;</button>
        </div>` : '';
      const imgBlock = b.img ? `<div class="bundle-img-wrap"><img src="${b.img}" alt="${escapeHtml(b.name)}" loading="lazy" decoding="async"></div>` : '';
      const itemsHtml = b.items.map((i) => {
        const match = findMatchingProduct(i, b.model);
        if (!match) return `<span>${escapeHtml(i)}</span>`;
        const mFinal = match.discount ? Math.round(match.price * (1 - match.discount / 100)) : match.price;
        return `<button type="button" class="bundle-item-link" data-item-code="${escapeHtml(match.code)}" aria-label="${escapeHtml(i)} — צפייה באביזר, מחיר ${escapeHtml(String(mFinal))} שקל">${escapeHtml(i)}<span class="bundle-item-tooltip" aria-hidden="true">${fmtPrice(mFinal)}</span></button>`;
      }).join('');
      return `
      <div class="bundle-card ${adminMode ? 'admin-mode' : ''}" style="position:relative; --i:${Math.min(bi, 12)};">
        ${adminOverlay}
        ${imgBlock}
        <div class="tier">${escapeHtml(HERO_NAME[b.model])} &middot; חבילה</div>
        <h3>${escapeHtml(b.name)}</h3>
        <div class="bundle-items">${itemsHtml}</div>
        <div class="bundle-price-row">
          ${b.old_price && save ? `<span class="bundle-old-price">${fmtPrice(b.old_price)}</span>` : ''}
          <div class="bundle-final-row">
            <span class="bundle-final-price">${fmtPrice(b.price)}</span>
            ${save ? `<span class="bundle-save">חיסכון ${save}%</span>` : ''}
          </div>
          <div class="bundle-code">${escapeHtml(b.code)}</div>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.bundle-item-link').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      goToProduct(el.dataset.itemCode);
    }));

    if (adminMode) {
      grid.querySelectorAll('[data-bedit]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openBundleModal(b.dataset.bedit); }));
      grid.querySelectorAll('[data-bdel]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); deleteBundle(b.dataset.bdel); }));
    }
    return;
  }

  const list = PRODUCTS.filter((p) => {
    if (!matchesModel(p)) return false;
    if (p.blocked && !adminMode) return false;
    if (state.cat !== 'all' && p.cat !== state.cat) return false;
    if (q && !(p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q))) return false;
    return true;
  });

  document.getElementById('resultCount').textContent = list.length + ' אביזרים';
  grid.style.display = list.length ? 'grid' : 'none';
  document.getElementById('emptyState').style.display = list.length ? 'none' : 'block';

  grid.innerHTML = list.map((p, pi) => {
    const img = productImg(p);
    const cat = CATS[p.cat] || { label: p.cat, color: '#999' };
    const modelBadge = p.model === 'both' ? '' : `<div class="model-tag">${escapeHtml(HERO_NAME[p.model])}</div>`;
    const hasDiscount = p.discount && p.discount > 0;
    const finalPrice = hasDiscount ? Math.round(p.price * (1 - p.discount / 100)) : p.price;
    const discountRibbon = hasDiscount ? `<div class="discount-ribbon">%-${p.discount}</div>` : '';
    const topLeftBadges = (modelBadge || discountRibbon) ? `<div class="badges-topleft">${modelBadge}${discountRibbon}</div>` : '';
    const adminOverlay = adminMode ? `
      <div class="card-admin-actions">
        <button class="icon-btn block${p.blocked ? ' is-blocked' : ''}" data-block="${escapeHtml(p.code)}" aria-label="${p.blocked ? 'שחרור חסימה' : 'חסימת פריט'} — ${escapeHtml(p.name)}" title="${p.blocked ? 'הצג שוב בקטלוג' : 'הסתר מהקטלוג (חסר במלאי)'}">${p.blocked ? '&#128065;&#65039;' : '&#128683;'}</button>
        <button class="icon-btn edit" data-edit="${escapeHtml(p.code)}" aria-label="עריכת אביזר ${escapeHtml(p.name)}">&#9998;&#65039;</button>
        <button class="icon-btn del" data-del="${escapeHtml(p.code)}" aria-label="מחיקת אביזר ${escapeHtml(p.name)}">&#128465;&#65039;</button>
      </div>` : '';
    return `
    <div class="card ${adminMode ? 'admin-mode' : ''}${p.blocked ? ' is-blocked' : ''}" style="--i:${Math.min(pi, 12)};">
      <div class="img-wrap">
        ${topLeftBadges}
        ${p.blocked ? `<div class="blocked-tag">חסום &middot; לא מוצג</div>` : ''}
        <div class="cat-tag" style="background:${cat.color}">${escapeHtml(cat.label)}</div>
        ${img ? `<img src="${img}" alt="${escapeHtml(p.name)}" loading="lazy" decoding="async" class="zoomable" data-zoom="${escapeHtml(p.code)}" tabindex="0" role="button" aria-label="הצגת תמונה מוגדלת של ${escapeHtml(p.name)}">` : `<div class="placeholder"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`}
        ${adminOverlay}
      </div>
      <div class="body">
        <h3>${escapeHtml(p.name)}</h3>
        <div class="desc">${escapeHtml(p.desc || '')}</div>
        <div class="foot">
          <div>
            ${hasDiscount ? `<div class="old-price">${fmtPrice(p.price)}</div>` : ''}
            <div class="price">${fmtPrice(finalPrice)}<small>כולל מע״מ</small></div>
          </div>
          ${hasDiscount ? `<div class="save-badge">חוסך ${fmtPrice(p.price - finalPrice)}</div>` : `<div class="sku">${escapeHtml(p.code)}</div>`}
        </div>
        ${hasDiscount ? `<div class="sku" style="text-align:left; margin-top:-4px;">${escapeHtml(p.code)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  if (adminMode) {
    grid.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openModal(b.dataset.edit); }));
    grid.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); deleteProduct(b.dataset.del); }));
    grid.querySelectorAll('[data-block]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); toggleBlockProduct(b.dataset.block); }));
  }
}

// ---------------- Splash / navigation ----------------
function enterCatalog(model) {
  hideBundleReturnBanner();
  state.model = model;
  document.querySelectorAll('#modelSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.model === model));
  document.getElementById('splashScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('topNav').style.display = 'flex';
  window.scrollTo(0, 0);
  applyHero();
  buildChips();
  syncStateToUrl();
  render();
}

document.querySelectorAll('.splash-card').forEach((card) => {
  card.addEventListener('click', () => enterCatalog(card.dataset.model));
});

function goToSplash(e) {
  if (e) e.preventDefault();
  hideBundleReturnBanner();
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('splashScreen').style.display = 'flex';
  document.getElementById('topNav').style.display = 'none';
  history.replaceState(null, '', location.pathname);
  window.scrollTo(0, 0);
}

document.getElementById('backToSplashLink').addEventListener('click', goToSplash);

document.getElementById('termsLink').addEventListener('click', (e) => {
  e.preventDefault();
  openOverlay('termsModalOverlay', '#termsModalTitle');
});
document.getElementById('termsCloseBtn').addEventListener('click', () => closeOverlay('termsModalOverlay'));
document.getElementById('termsModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'termsModalOverlay') closeOverlay('termsModalOverlay');
});

document.getElementById('brandLogo').addEventListener('click', goToSplash);
document.getElementById('brandLogo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') goToSplash(e);
});

document.getElementById('modelSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  hideBundleReturnBanner();
  state.model = btn.dataset.model;
  applyHero();
  syncStateToUrl();
  render();
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  hideBundleReturnBanner();
  state.q = e.target.value;
  syncStateToUrl();
  render();
});

// ---------------- Lightbox ----------------
let lastFocusedEl = null;

function openLightbox(code) {
  const p = PRODUCTS.find((x) => x.code === code);
  if (!p) return;
  const img = productImg(p);
  if (!img) return;
  const hasDiscount = p.discount && p.discount > 0;
  const finalPrice = hasDiscount ? Math.round(p.price * (1 - p.discount / 100)) : p.price;
  document.getElementById('lightboxImg').src = img;
  document.getElementById('lightboxImg').alt = p.name;
  document.getElementById('lightboxName').textContent = p.name;
  document.getElementById('lightboxPrice').innerHTML = fmtPrice(finalPrice);
  lastFocusedEl = document.activeElement;
  document.getElementById('lightbox').classList.add('show');
  document.getElementById('lightboxClose').focus();
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('show');
  if (bundleReturnState) {
    // Item was opened from inside a bundle — go straight back to it
    // instead of leaving the user on a single-item filtered catalog view.
    returnToBundleView();
    return;
  }
  if (lastFocusedEl) lastFocusedEl.focus();
}
document.getElementById('grid').addEventListener('click', (e) => {
  if (adminMode) return;
  const img = e.target.closest('.zoomable');
  if (img) openLightbox(img.dataset.zoom);
});
document.getElementById('grid').addEventListener('keydown', (e) => {
  if (adminMode) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const img = e.target.closest('.zoomable');
  if (img) { e.preventDefault(); openLightbox(img.dataset.zoom); }
});
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});
document.getElementById('lightboxClose').addEventListener('click', closeLightbox);

// ---------------- Generic dialog keyboard handling (Escape + focus trap) ----------------
const ALL_OVERLAY_IDS = ['modalOverlay', 'homeModalOverlay', 'splashModalOverlay', 'bundleModalOverlay', 'loginModalOverlay', 'termsModalOverlay'];

function topOpenOverlay() {
  for (const id of ALL_OVERLAY_IDS) {
    const el = document.getElementById(id);
    if (el.classList.contains('show')) return el;
  }
  if (document.getElementById('lightbox').classList.contains('show')) return document.getElementById('lightbox');
  return null;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = topOpenOverlay();
  if (!open) return;
  if (open.id === 'lightbox') { closeLightbox(); return; }
  open.classList.remove('show');
});

// Basic focus trap for any open modal-overlay dialog.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const open = topOpenOverlay();
  if (!open || open.id === 'lightbox') return;
  const focusable = open.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function openOverlay(id, focusSelector) {
  lastFocusedEl = document.activeElement;
  const overlay = document.getElementById(id);
  overlay.classList.add('show');
  const target = focusSelector ? overlay.querySelector(focusSelector) : overlay.querySelector('input, textarea, select, button');
  if (target) target.focus();
}
function closeOverlay(id) {
  document.getElementById(id).classList.remove('show');
  if (lastFocusedEl) lastFocusedEl.focus();
}

// ---------------- Admin authentication (real Supabase Auth, no PIN) ----------------
let adminMode = false;
let currentSession = null;

async function refreshSessionUi() {
  const { data } = await sb.auth.getSession();
  currentSession = data.session;
  adminMode = !!currentSession;
  updateAdminUi();
  render();
}

function updateAdminUi() {
  document.getElementById('adminToggleBtn').classList.toggle('on', adminMode);
  document.getElementById('adminToggleBtn').textContent = adminMode ? 'יציאה ממצב ניהול' : 'מצב ניהול';
  document.getElementById('adminBar').style.display = adminMode ? 'flex' : 'none';
  document.getElementById('pdfStarrayBtn').style.display = adminMode ? 'inline-block' : 'none';
  document.getElementById('pdfEx5Btn').style.display = adminMode ? 'inline-block' : 'none';
  document.getElementById('exportSiteBtn').style.display = adminMode ? 'inline-block' : 'none';
  document.getElementById('exportBtn').style.display = adminMode ? 'inline-block' : 'none';
  document.getElementById('importBtn').style.display = adminMode ? 'inline-flex' : 'none';
  document.getElementById('addFab').classList.toggle('show', adminMode);
  document.getElementById('editHomeBtn').style.display = adminMode ? 'inline-block' : 'none';
  document.getElementById('editSplashBtn').style.display = adminMode ? 'inline-block' : 'none';
}

document.getElementById('adminToggleBtn').addEventListener('click', async () => {
  if (adminMode) {
    await sb.auth.signOut();
    adminMode = false;
    updateAdminUi();
    render();
    return;
  }
  document.getElementById('loginError').textContent = '';
  document.getElementById('loginForm').reset();
  openOverlay('loginModalOverlay', '#login_email');
});

document.getElementById('loginCancelBtn').addEventListener('click', () => closeOverlay('loginModalOverlay'));
document.getElementById('loginModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'loginModalOverlay') closeOverlay('loginModalOverlay'); });

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login_email').value.trim();
  const password = document.getElementById('login_password').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const submitBtn = document.getElementById('loginSubmitBtn');
  submitBtn.disabled = true;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentSession = data.session;
    adminMode = true;
    closeOverlay('loginModalOverlay');
    updateAdminUi();
    render();
    showToast('התחברת בהצלחה');
  } catch (err) {
    errEl.textContent = 'התחברות נכשלה: שם משתמש או סיסמה שגויים';
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------------- Product CRUD ----------------
document.getElementById('addFab').addEventListener('click', () => {
  if (!adminMode) return;
  if (state.cat === 'bundles') openBundleModal(null);
  else openModal(null);
});

let pendingImageData = null;

function openModal(code) {
  const isEdit = !!code;
  const p = isEdit ? PRODUCTS.find((x) => x.code === code) : null;
  document.getElementById('modalTitle').textContent = isEdit ? 'עריכת אביזר' : 'הוספת אביזר';
  document.getElementById('f_originalCode').value = isEdit ? code : '';
  document.getElementById('f_name').value = p ? p.name : '';
  document.getElementById('f_code').value = p ? p.code : '';
  document.getElementById('f_price').value = p ? p.price : '';
  document.getElementById('f_discount').value = p && p.discount ? p.discount : '';
  document.getElementById('f_model').value = p ? p.model : 'both';
  document.getElementById('f_cat').value = p ? p.cat : 'charging';
  document.getElementById('f_desc').value = p ? (p.desc || '') : '';
  document.getElementById('deleteBtn').style.display = isEdit ? 'inline-block' : 'none';

  const existingImg = p ? (p.img_sr || p.img_ex) : null;
  pendingImageData = null;
  const preview = document.getElementById('f_imgPreview');
  const label = document.getElementById('f_imgLabel');
  if (existingImg) { preview.src = existingImg; preview.style.display = 'block'; label.textContent = 'לחצו כדי להחליף תמונה'; }
  else { preview.style.display = 'none'; label.textContent = 'לחצו כדי להעלות תמונה (אופציונלי)'; }

  openOverlay('modalOverlay', '#f_name');
}
function closeModal() { closeOverlay('modalOverlay'); pendingImageData = null; }

document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB guard on uploaded images

document.getElementById('f_imgFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('יש לבחור קובץ תמונה בלבד'); e.target.value = ''; return; }
  if (file.size > MAX_IMAGE_BYTES) { alert('התמונה גדולה מדי (מקסימום 4MB)'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingImageData = ev.target.result;
    const preview = document.getElementById('f_imgPreview');
    preview.src = pendingImageData;
    preview.style.display = 'block';
    document.getElementById('f_imgLabel').textContent = 'לחצו כדי להחליף תמונה';
  };
  reader.readAsDataURL(file);
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!adminMode) return;
  const originalCode = document.getElementById('f_originalCode').value;
  const existing = originalCode ? PRODUCTS.find((x) => x.code === originalCode) : null;

  const draft = {
    code: document.getElementById('f_code').value.trim(),
    name: document.getElementById('f_name').value.trim(),
    price: parseFloat(document.getElementById('f_price').value),
    discount: document.getElementById('f_discount').value ? clampNumber(document.getElementById('f_discount').value, 0, 95) : 0,
    model: document.getElementById('f_model').value,
    cat: document.getElementById('f_cat').value,
    desc: document.getElementById('f_desc').value.trim(),
    img_sr: pendingImageData || (existing ? existing.img_sr : null),
    img_ex: pendingImageData || (existing ? existing.img_ex : null),
    blocked: existing ? !!existing.blocked : false,
  };

  const result = validateProduct(draft);
  if (!result.ok) { alert('שגיאה בנתונים:\n' + result.errors.join('\n')); return; }
  const productData = result.value;

  const saveBtnEl = document.getElementById('saveBtn');
  saveBtnEl.disabled = true;
  try {
    if (originalCode && originalCode !== productData.code) {
      await sb.from('accessories').delete().eq('code', originalCode);
    }
    const { error } = await sb.from('accessories').upsert(toDbProduct(productData));
    if (error) throw error;

    if (originalCode) {
      const idx = PRODUCTS.findIndex((x) => x.code === originalCode);
      if (idx > -1) PRODUCTS[idx] = productData; else PRODUCTS.push(productData);
    } else {
      PRODUCTS.push(productData);
    }

    closeModal();
    render();
    showToast('✓ נשמר');
  } catch (err) {
    console.error(err);
    showError('השמירה נכשלה: ' + (err.message || 'שגיאת שרת'));
  } finally {
    saveBtnEl.disabled = false;
  }
});

async function deleteProduct(code) {
  if (!adminMode) return;
  if (!confirm('למחוק את האביזר הזה מהקטלוג?')) return;
  try {
    const { error } = await sb.from('accessories').delete().eq('code', code);
    if (error) throw error;
    const idx = PRODUCTS.findIndex((x) => x.code === code);
    if (idx > -1) PRODUCTS.splice(idx, 1);
    render();
    showToast('✓ נמחק');
  } catch (err) {
    console.error(err);
    showError('המחיקה נכשלה: ' + (err.message || 'שגיאת שרת'));
  }
}

// "Block item": hides an out-of-stock accessory from the public catalog
// and from generated PDFs, without deleting it — one click to restore it
// once stock is back.
async function toggleBlockProduct(code) {
  if (!adminMode) return;
  const p = PRODUCTS.find((x) => x.code === code);
  if (!p) return;
  const nextBlocked = !p.blocked;
  try {
    const { error } = await sb.from('accessories').update({ blocked: nextBlocked }).eq('code', code);
    if (error) throw error;
    p.blocked = nextBlocked;
    render();
    showToast(nextBlocked ? '✓ הפריט נחסם ולא יוצג בקטלוג' : '✓ הפריט זמין שוב בקטלוג');
  } catch (err) {
    console.error(err);
    showError('הפעולה נכשלה: ' + (err.message || 'שגיאת שרת'));
  }
}

document.getElementById('deleteBtn').addEventListener('click', () => {
  const originalCode = document.getElementById('f_originalCode').value;
  closeModal();
  if (originalCode) deleteProduct(originalCode);
});

// ---------------- Bundle CRUD ----------------
let pendingBundleImageData = null;

function openBundleModal(code) {
  const isEdit = !!code;
  const b = isEdit ? BUNDLES.find((x) => x.code === code) : null;
  document.getElementById('bundleModalTitle').textContent = isEdit ? 'עריכת חבילה' : 'הוספת חבילה';
  document.getElementById('b_originalCode').value = isEdit ? code : '';
  document.getElementById('b_name').value = b ? b.name : '';
  document.getElementById('b_code').value = b ? b.code : '';
  document.getElementById('b_model').value = b ? b.model : state.model;
  document.getElementById('b_oldprice').value = b && b.old_price ? b.old_price : '';
  document.getElementById('b_price').value = b ? b.price : '';
  document.getElementById('b_items').value = b ? b.items.join('\n') : '';
  document.getElementById('bundleDeleteBtn').style.display = isEdit ? 'inline-block' : 'none';

  pendingBundleImageData = null;
  const bPreview = document.getElementById('b_imgPreview');
  const bLabel = document.getElementById('b_imgLabel');
  if (b && b.img) { bPreview.src = b.img; bPreview.style.display = 'block'; bLabel.textContent = 'לחצו כדי להחליף תמונה'; }
  else { bPreview.style.display = 'none'; bPreview.src = ''; bLabel.textContent = 'לחצו כדי להעלות תמונה (אופציונלי)'; }

  openOverlay('bundleModalOverlay', '#b_name');
}
function closeBundleModal() { closeOverlay('bundleModalOverlay'); pendingBundleImageData = null; }

document.getElementById('bundleCancelBtn').addEventListener('click', closeBundleModal);
document.getElementById('bundleModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'bundleModalOverlay') closeBundleModal(); });

document.getElementById('b_imgFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('יש לבחור קובץ תמונה בלבד'); e.target.value = ''; return; }
  if (file.size > MAX_IMAGE_BYTES) { alert('התמונה גדולה מדי (מקסימום 4MB)'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingBundleImageData = ev.target.result;
    const preview = document.getElementById('b_imgPreview');
    preview.src = pendingBundleImageData;
    preview.style.display = 'block';
    document.getElementById('b_imgLabel').textContent = 'לחצו כדי להחליף תמונה';
  };
  reader.readAsDataURL(file);
});

document.getElementById('bundleSaveBtn').addEventListener('click', async () => {
  if (!adminMode) return;
  const originalCode = document.getElementById('b_originalCode').value;
  const existingBundle = originalCode ? BUNDLES.find((x) => x.code === originalCode) : null;
  const draft = {
    code: document.getElementById('b_code').value.trim(),
    name: document.getElementById('b_name').value.trim(),
    model: document.getElementById('b_model').value,
    old_price: document.getElementById('b_oldprice').value ? parseFloat(document.getElementById('b_oldprice').value) : null,
    price: parseFloat(document.getElementById('b_price').value),
    items: document.getElementById('b_items').value.split('\n').map((s) => s.trim()).filter(Boolean),
    img: pendingBundleImageData || (existingBundle ? existingBundle.img : null),
  };

  const result = validateBundle(draft);
  if (!result.ok) { alert('שגיאה בנתונים:\n' + result.errors.join('\n')); return; }
  const bundleData = result.value;

  const bundleSaveBtnEl = document.getElementById('bundleSaveBtn');
  bundleSaveBtnEl.disabled = true;
  try {
    if (originalCode && originalCode !== bundleData.code) {
      await sb.from('bundles').delete().eq('code', originalCode);
    }
    const { error } = await sb.from('bundles').upsert(toDbBundle(bundleData));
    if (error) throw error;

    if (originalCode) {
      const idx = BUNDLES.findIndex((x) => x.code === originalCode);
      if (idx > -1) BUNDLES[idx] = bundleData; else BUNDLES.push(bundleData);
    } else {
      BUNDLES.push(bundleData);
    }

    closeBundleModal();
    render();
    showToast('✓ נשמר');
  } catch (err) {
    console.error(err);
    showError('השמירה נכשלה: ' + (err.message || 'שגיאת שרת'));
  } finally {
    bundleSaveBtnEl.disabled = false;
  }
});

async function deleteBundle(code) {
  if (!adminMode) return;
  if (!confirm('למחוק את החבילה הזו מהקטלוג?')) return;
  try {
    const { error } = await sb.from('bundles').delete().eq('code', code);
    if (error) throw error;
    const idx = BUNDLES.findIndex((x) => x.code === code);
    if (idx > -1) BUNDLES.splice(idx, 1);
    render();
    showToast('✓ נמחק');
  } catch (err) {
    console.error(err);
    showError('המחיקה נכשלה: ' + (err.message || 'שגיאת שרת'));
  }
}

document.getElementById('bundleDeleteBtn').addEventListener('click', () => {
  const originalCode = document.getElementById('b_originalCode').value;
  closeBundleModal();
  if (originalCode) deleteBundle(originalCode);
});

// ---------------- Export / Import ----------------
function exportFullSite() {
  showToast('לתפוצה מלאה של האתר יש להשתמש בקבצי המקור (index.html, app.js, data.json) ולא בקובץ בודד');
}
document.getElementById('exportSiteBtn').addEventListener('click', exportFullSite);

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ products: PRODUCTS, bundles: BUNDLES }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'geely-accessories-data.json';
  a.click();
  URL.revokeObjectURL(url);
});

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

document.getElementById('importFile').addEventListener('change', (e) => {
  if (!adminMode) return;
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) { alert('קובץ הייבוא גדול מדי'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async (ev) => {
    let imported;
    try {
      imported = JSON.parse(ev.target.result);
    } catch {
      alert('קובץ JSON לא תקין');
      e.target.value = '';
      return;
    }

    const rawProducts = Array.isArray(imported) ? imported : (Array.isArray(imported?.products) ? imported.products : null);
    const rawBundles = Array.isArray(imported?.bundles) ? imported.bundles : [];

    if (!rawProducts) { alert('קובץ לא תקין: חסר מערך products'); e.target.value = ''; return; }

    const validProducts = [];
    const productErrors = [];
    rawProducts.forEach((p, i) => {
      const r = validateProduct(p || {});
      if (r.ok) validProducts.push(r.value);
      else productErrors.push(`אביזר #${i + 1}: ${r.errors.join(', ')}`);
    });

    const validBundles = [];
    const bundleErrors = [];
    rawBundles.forEach((b, i) => {
      const r = validateBundle(b || {});
      if (r.ok) validBundles.push(r.value);
      else bundleErrors.push(`חבילה #${i + 1}: ${r.errors.join(', ')}`);
    });

    if (!validProducts.length) {
      alert('לא נמצאו אביזרים תקינים בקובץ. שגיאות:\n' + productErrors.slice(0, 10).join('\n'));
      e.target.value = '';
      return;
    }

    const summary = `יובאו ${validProducts.length}/${rawProducts.length} אביזרים ו-${validBundles.length}/${rawBundles.length} חבילות תקינים.\n`
      + `הייבוא מוסיף/מעדכן לפי מק"ט — לא מוחק אביזרים קיימים שלא נמצאים בקובץ.`
      + (productErrors.length || bundleErrors.length
        ? `\n\nנפסלו:\n${productErrors.concat(bundleErrors).slice(0, 15).join('\n')}`
        : '')
      + '\n\nלהמשיך ולשמור למסד הנתונים?';
    if (!confirm(summary)) { e.target.value = ''; return; }

    try {
      // Merge by code: update existing items, add new ones. Existing
      // accessories/bundles that are NOT in the imported file are left
      // untouched — importing never deletes anything.
      validProducts.forEach((p) => {
        const idx = PRODUCTS.findIndex((x) => x.code === p.code);
        if (idx > -1) PRODUCTS[idx] = p; else PRODUCTS.push(p);
      });
      validBundles.forEach((b) => {
        const idx = BUNDLES.findIndex((x) => x.code === b.code);
        if (idx > -1) BUNDLES[idx] = b; else BUNDLES.push(b);
      });
      render();

      const { error: pErr } = await sb.from('accessories').upsert(validProducts.map(toDbProduct));
      if (pErr) throw pErr;
      if (validBundles.length) {
        const { error: bErr } = await sb.from('bundles').upsert(validBundles.map(toDbBundle));
        if (bErr) throw bErr;
      }
      showToast('✓ הנתונים יובאו ונשמרו במסד הנתונים');
    } catch (err) {
      console.error(err);
      showError('הייבוא נשמר מקומית אך הסנכרון למסד הנתונים נכשל: ' + (err.message || 'שגיאת שרת'));
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------------- PDF export (via print) ----------------
function exportPdf(model) {
  const pv = document.getElementById('printView');
  const modelName = HERO_NAME[model];
  const heroImg = SITE_CONTENT.models[model].img;
  const prods = PRODUCTS.filter((p) => (p.model === 'both' || p.model === model) && !p.blocked);
  const bnds = BUNDLES.filter((b) => b.model === model);
  const issueDate = new Date().toLocaleDateString('he-IL', { year: 'numeric', month: 'long', day: 'numeric' });

  const productCard = (p) => {
    const img = model === 'starray' ? p.img_sr : p.img_ex;
    const cat = CATS[p.cat] || { label: p.cat, color: '#9aa0b2' };
    const hasDiscount = p.discount && p.discount > 0;
    const finalPrice = hasDiscount ? Math.round(p.price * (1 - p.discount / 100)) : p.price;
    return `
    <div class="pv-card">
      <div class="pv-img">
        <span class="pv-cat-tag" style="color:${cat.color}">${escapeHtml(cat.label)}</span>
        ${img ? `<img src="${img}">` : ''}
      </div>
      <div class="pv-body">
        <h4>${escapeHtml(p.name)}</h4>
        <div class="pv-desc">${escapeHtml(p.desc || '')}</div>
        <div class="pv-foot">
          <span class="pv-price-wrap">
            ${hasDiscount ? `<span class="pv-oldprice">${fmtPrice(p.price)}</span>` : ''}
            <span class="pv-price">${fmtPrice(finalPrice)}</span>
          </span>
          <span class="pv-sku">${escapeHtml(p.code)}</span>
        </div>
      </div>
    </div>`;
  };

  // Group accessories by category (in a fixed, deliberate order) instead of
  // one flat grid, so the printed catalog reads like an organized brochure.
  const catBlocks = Object.entries(CATS).map(([catKey, catInfo]) => {
    const items = prods.filter((p) => p.cat === catKey);
    if (!items.length) return '';
    return `
    <div class="pv-cat-block">
      <div class="pv-cat-header">
        <h3>${escapeHtml(catInfo.label)}</h3>
        <span class="pv-cat-count">${items.length} פריטים</span>
      </div>
      <div class="pv-grid">${items.map(productCard).join('')}</div>
    </div>`;
  }).join('');

  const bundleCards = bnds.map((b) => {
    const save = b.old_price && b.old_price > b.price ? Math.round(100 * (b.old_price - b.price) / b.old_price) : null;
    const imgBlock = b.img ? `<div class="pv-bundle-img"><img src="${b.img}"></div>` : '';
    return `
    <div class="pv-bundle">
      ${imgBlock}
      <div class="pv-bundle-body">
        <h4>${escapeHtml(b.name)}</h4>
        <ul class="pv-items">${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        <div class="pv-bfoot">
          <span class="pv-price-wrap" style="flex-direction:row; align-items:baseline; gap:2mm;">
            ${b.old_price && save ? `<span class="pv-oldprice">${fmtPrice(b.old_price)}</span>` : ''}
            <span class="pv-price">${fmtPrice(b.price)}</span>
            ${save ? `<span class="pv-save">חיסכון ${save}%</span>` : ''}
          </span>
          <span class="pv-sku">${escapeHtml(b.code)}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  pv.innerHTML = `
    <div class="pv-page-frame"></div>

    <div class="pv-cover">
      <div class="pv-cover-mark"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <div class="pv-cover-photo">${heroImg ? `<img src="${heroImg}">` : ''}</div>
      <div class="pv-logo"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <div class="pv-brand">GEELY</div>
      <div class="pv-eyebrow">קטלוג רשמי</div>
      <h1>${escapeHtml(modelName)}</h1>
      <div class="pv-sub">אביזרים וחבילות משתלמות</div>
      <div class="pv-cover-rule"></div>
      <div class="pv-cover-date">הופק בתאריך ${escapeHtml(issueDate)}</div>
    </div>

    <div class="pv-divider">
      <div class="pv-divider-index">01 &middot; אביזרים</div>
      <h2>אביזרים ל-${escapeHtml(modelName)}</h2>
      <div class="pv-divider-rule"></div>
      <p>מבחר אביזרי השדרוג, ההגנה, הטעינה והעיצוב הרשמיים לרכב שלכם &mdash; ${prods.length} פריטים.</p>
    </div>
    ${catBlocks}

    ${bnds.length ? `
      <div class="pv-divider">
        <div class="pv-divider-index">02 &middot; חבילות</div>
        <h2>חבילות משתלמות</h2>
        <div class="pv-divider-rule"></div>
        <p>שילובי אביזרים נבחרים במחיר מיוחד &mdash; ${bnds.length} חבילות זמינות.</p>
      </div>
      <div class="pv-grid pv-grid-bundles">${bundleCards}</div>
    ` : ''}

    <div class="pv-footer">
      ${escapeHtml(SITE_CONTENT.footer1)}<br>${escapeHtml(SITE_CONTENT.footer2)}<br>
      * המחירים עבור התוספות כפופים למחיר המחירון העדכני של חברתנו במועד תשלום התוספות
    </div>

    <div class="pv-legal-full">הקטלוג מופעל על ידי גיאו מוביליטי בע"מ, ח.פ. 516271350, יבואנית רכבי GEELY בישראל. המחירים בש"ח וכוללים מע"מ כשיעורו כדין, נכונים למועד פרסומם וניתנים לעדכון מעת לעת. התמונות להמחשה בלבד. המוצרים בכפוף למלאי הקיים. אין כפל מבצעים והנחות. אספקה והתקנה בהתאם לתנאי ההזמנה. ט.ל.ח. הרכישה כפופה להבהרות המשפטיות המלאות המופיעות בקטלוג. שירות לקוחות 8133* www.geely.co.il</div>

    <div class="pv-page-footer">
      <span>GEELY &middot; קטלוג ${escapeHtml(modelName)} רשמי</span>
      <span>${escapeHtml(issueDate)}</span>
    </div>
  `;

  const imgs = pv.querySelectorAll('img');
  let pending = imgs.length;
  const go = () => { window.print(); };
  if (!pending) { go(); return; }
  imgs.forEach((im) => {
    if (im.complete) { if (--pending === 0) go(); }
    else { im.onload = im.onerror = () => { if (--pending === 0) go(); }; }
  });
}

document.getElementById('pdfStarrayBtn').addEventListener('click', () => { if (adminMode) exportPdf('starray'); });
document.getElementById('pdfEx5Btn').addEventListener('click', () => { if (adminMode) exportPdf('ex5'); });

// ---------------- Home / splash content editing ----------------
let pendingHeroImage = null;

document.getElementById('editHomeBtn').addEventListener('click', () => {
  if (!adminMode) return;
  const m = SITE_CONTENT.models[state.model];
  document.getElementById('homeModelLabel').textContent = HERO_NAME[state.model];
  document.getElementById('homeModelLabel2').textContent = HERO_NAME[state.model];
  document.getElementById('homeModelLabel3').textContent = HERO_NAME[state.model];
  document.getElementById('h_imgPreview').src = m.img;
  document.getElementById('h_imgPreview').style.display = 'block';
  document.getElementById('h_title').value = (m.title && m.title.trim()) || `אביזרי ${HERO_NAME[state.model]} המקוריים`;
  document.getElementById('h_eyebrow').value = SITE_CONTENT.eyebrow;
  document.getElementById('h_heroText').value = m.text;
  document.getElementById('h_footer1').value = SITE_CONTENT.footer1;
  document.getElementById('h_footer2').value = SITE_CONTENT.footer2;
  pendingHeroImage = null;
  openOverlay('homeModalOverlay', '#h_title');
});

document.getElementById('homeCancelBtn').addEventListener('click', () => closeOverlay('homeModalOverlay'));
document.getElementById('homeModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'homeModalOverlay') closeOverlay('homeModalOverlay'); });

document.getElementById('h_imgFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('יש לבחור קובץ תמונה בלבד'); e.target.value = ''; return; }
  if (file.size > MAX_IMAGE_BYTES) { alert('התמונה גדולה מדי (מקסימום 4MB)'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingHeroImage = ev.target.result;
    document.getElementById('h_imgPreview').src = pendingHeroImage;
    document.getElementById('h_imgPreview').style.display = 'block';
  };
  reader.readAsDataURL(file);
});

document.getElementById('homeSaveBtn').addEventListener('click', () => {
  if (!adminMode) return;
  const m = SITE_CONTENT.models[state.model];
  if (pendingHeroImage) m.img = pendingHeroImage;
  m.title = document.getElementById('h_title').value.trim().slice(0, 120);
  m.text = document.getElementById('h_heroText').value.trim().slice(0, 400);
  SITE_CONTENT.eyebrow = document.getElementById('h_eyebrow').value.trim().slice(0, 120);
  SITE_CONTENT.footer1 = document.getElementById('h_footer1').value.trim().slice(0, 200);
  SITE_CONTENT.footer2 = document.getElementById('h_footer2').value.trim().slice(0, 200);
  applyHero();
  updateSplashImages();
  closeOverlay('homeModalOverlay');
  persistSiteContent();
});

document.getElementById('editSplashBtn').addEventListener('click', () => {
  if (!adminMode) return;
  document.getElementById('s_eyebrow').value = SITE_CONTENT.splash.eyebrow;
  document.getElementById('s_title').value = SITE_CONTENT.splash.title;
  document.getElementById('s_sub').value = SITE_CONTENT.splash.sub;
  document.getElementById('s_cta').value = SITE_CONTENT.splash.cta;
  openOverlay('splashModalOverlay', '#s_eyebrow');
});

document.getElementById('splashCancelBtn').addEventListener('click', () => closeOverlay('splashModalOverlay'));
document.getElementById('splashModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'splashModalOverlay') closeOverlay('splashModalOverlay'); });

document.getElementById('splashSaveBtn').addEventListener('click', () => {
  if (!adminMode) return;
  SITE_CONTENT.splash.eyebrow = document.getElementById('s_eyebrow').value.trim().slice(0, 120);
  SITE_CONTENT.splash.title = document.getElementById('s_title').value.trim().slice(0, 120);
  SITE_CONTENT.splash.sub = document.getElementById('s_sub').value.trim().slice(0, 160);
  SITE_CONTENT.splash.cta = document.getElementById('s_cta').value.trim().slice(0, 60);
  applySplashText();
  closeOverlay('splashModalOverlay');
  persistSiteContent();
});

// ---------------- Init ----------------
document.getElementById('retryBtn').addEventListener('click', () => init());

async function init() {
  hideError();
  setLoading(true);
  try {
    if (!SEED_CONTENT) await loadSeed();
    await Promise.all([
      loadProductsFromSupabase(),
      loadBundlesFromSupabase(),
      loadSiteContentFromSupabase(),
    ]);
    await refreshSessionUi();

    const hasModelInUrl = readStateFromUrl();
    buildChips();
    updateSplashImages();
    applySplashText();
    applyHero();
    render();

    if (hasModelInUrl) {
      enterCatalog(state.model);
    }

    setLoading(false);
  } catch (err) {
    console.error('Failed to initialize catalog', err);
    setLoading(false);
    showError('לא ניתן היה לטעון את הקטלוג מהשרת. בדקו את החיבור לאינטרנט ונסו שוב.');
  }
}

sb.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  adminMode = !!session;
  updateAdminUi();
});

// ---------------- Site access gate ----------------
// This only controls whether the *page UI* is shown in this browser. It is
// a soft deterrent (keeps casual visitors / search engines out), NOT real
// access control: the code lives in this public JS file, and the catalog
// data itself is still readable directly from Supabase by anyone with the
// project URL (by design — see supabase-setup.sql). Do not rely on this
// for anything that must stay confidential. Real protection (blocking
// writes/edits/deletes) is the Supabase Auth + RLS setup, which is
// unaffected by this gate.
const SITE_ACCESS_CODE = '2514';
const ACCESS_STORAGE_KEY = 'geely_catalog_access_ok';

function showAccessGate() {
  document.getElementById('appLoading').hidden = true;
  document.getElementById('accessGate').hidden = false;
  document.getElementById('accessGateInput').focus();
}
function passAccessGate() {
  document.getElementById('accessGate').hidden = true;
  init();
}

document.getElementById('accessGateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const val = document.getElementById('accessGateInput').value.trim();
  const errEl = document.getElementById('accessGateError');
  if (val === SITE_ACCESS_CODE) {
    try { localStorage.setItem(ACCESS_STORAGE_KEY, '1'); } catch { /* localStorage may be unavailable; not critical */ }
    errEl.textContent = '';
    passAccessGate();
  } else {
    errEl.textContent = 'קוד שגוי, נסו שוב';
    document.getElementById('accessGateInput').value = '';
    document.getElementById('accessGateInput').focus();
  }
});

let alreadyHasAccess = false;
try { alreadyHasAccess = localStorage.getItem(ACCESS_STORAGE_KEY) === '1'; } catch { /* ignore */ }

if (alreadyHasAccess) {
  document.getElementById('accessGate').hidden = true;
  init();
} else {
  showAccessGate();
}
