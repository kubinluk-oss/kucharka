// UI primitivy: loader, toasty, potvrzovací/vstupní dialogy, sheety, výběr hvězdiček.
import { escapeHtml } from './util.js';

/* Jediná sada ovládacích ikon pro celou appku (čára 2, zaoblené konce, 24×24).
   Místo textových znaků ›, ✕, ＋ — ty se na každém zařízení vykreslí jinak
   (jiné písmo, jiná tloušťka, jiná výška) a nesedí k ostatním ikonám. */
const svg = d => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICON = {
  chevron: svg('<path d="M9.5 6l6 6-6 6"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
};

/* ---------- Zámek scrollování pozadí ----------
   Dokud je otevřený panel, dialog nebo loader, stránka pod nimi se nesmí hýbat.
   Dřív se body „přišpendlilo" (position:fixed) — v appce na ploše iPhonu to ale
   při otevření posunulo spodní okraj (bezpečná zóna) a panel při najetí poskočil.
   Teď se rozložení nemění vůbec: html dostane overflow:hidden (počítač) a na
   dotyk posouvání zastaví samotné pozadí okna (touch-action v CSS), zatímco
   obsah okna se posouvá dál a do stránky „nepropadne" (overscroll-behavior). */
let scrollLocks = 0;
function lockScroll() {
  if (++scrollLocks > 1) return;
  document.documentElement.classList.add('scroll-locked');
}
function unlockScroll() {
  if (scrollLocks === 0 || --scrollLocks > 0) return;
  document.documentElement.classList.remove('scroll-locked');
}
/* iOS (Safari 26+) přizpůsobuje horní pruh tomu, co je u horního okraje. Ztmavené
   pozadí okna/menu přes celou obrazovku ho přepne a po zavření se to někdy srovná
   až při dalším posunutí stránky. Neznatelné šťouchnutí (o pixel tam a zpět)
   přinutí iOS stav přepočítat hned. */
export function refreshTopEdge() {
  requestAnimationFrame(() => {
    const y = window.scrollY;
    window.scrollTo(0, y + 1);
    window.scrollTo(0, y);
  });
}

// Dotykové posouvání pod otevřeným oknem zastavíme — kromě míst, která se posouvat
// mají (obsah panelu, menu, výběr emoji).
document.addEventListener('touchmove', e => {
  if (scrollLocks && !e.target.closest('.sheet-body, .ctx-menu, .ep-scroll')) e.preventDefault();
}, { passive: false });

/* ---------- Loader ---------- */
let loaderShown = false;
export function showLoader(label) {
  document.getElementById('loader-label').textContent = label || 'Načítám…';
  document.getElementById('loader').hidden = false;
  if (!loaderShown) { loaderShown = true; lockScroll(); }
}
export function hideLoader() {
  document.getElementById('loader').hidden = true;
  if (loaderShown) { loaderShown = false; unlockScroll(); }
}

/* ---------- Toast ---------- */
export function toast(msg, ms = 2200) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

/* ---------- Confirm / Prompt (in-app, ne systémové) ---------- */
function modalBase(inner) {
  const root = document.getElementById('modal-root');
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal-box">${inner}</div>`;
  root.appendChild(bd);
  lockScroll();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unlockScroll();
    bd.classList.add('closing');
    setTimeout(() => { bd.remove(); refreshTopEdge(); }, 180);
  };
  return { bd, close };
}

export function confirmDialog(title, msg, { okLabel = 'OK', danger = false, cancelLabel = 'Zrušit' } = {}) {
  return new Promise(resolve => {
    const { bd, close } = modalBase(`
      <h2 class="modal-title">${escapeHtml(title)}</h2>
      <p class="modal-msg">${escapeHtml(msg)}</p>
      <div class="modal-btns">
        <button class="btn" data-act="cancel">${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(okLabel)}</button>
      </div>`);
    bd.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') { close(); resolve(true); }
      else if (act === 'cancel' || e.target === bd) { close(); resolve(false); }
    });
  });
}

// Zkopíruje text do schránky a ohlásí to. Vrací true/false (volající může třeba zavřít sheet).
export async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
  catch { alertDialog('Kopírování se nepovedlo', 'Prohlížeč nedovolil přístup ke schránce.'); return false; }
}

export function alertDialog(title, msg) {
  return new Promise(resolve => {
    const { bd, close } = modalBase(`
      <h2 class="modal-title">${escapeHtml(title)}</h2>
      <p class="modal-msg">${escapeHtml(msg)}</p>
      <div class="modal-btns"><button class="btn btn-primary" data-act="ok">OK</button></div>`);
    bd.addEventListener('click', e => {
      if (e.target.closest('[data-act]') || e.target === bd) { close(); resolve(); }
    });
  });
}

export function promptDialog(title, msg, { value = '', placeholder = '', okLabel = 'Uložit' } = {}) {
  return new Promise(resolve => {
    const { bd, close } = modalBase(`
      <h2 class="modal-title">${escapeHtml(title)}</h2>
      ${msg ? `<p class="modal-msg">${escapeHtml(msg)}</p>` : ''}
      <input class="form-input" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" maxlength="60">
      <div class="modal-btns">
        <button class="btn" data-act="cancel">Zrušit</button>
        <button class="btn btn-primary" data-act="ok">${escapeHtml(okLabel)}</button>
      </div>`);
    const input = bd.querySelector('input');
    setTimeout(() => input.focus(), 80);
    const submit = () => {
      const v = input.value.trim();
      close();
      resolve(v || null);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    bd.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') submit();
      else if (act === 'cancel' || e.target === bd) { close(); resolve(null); }
    });
  });
}

/* ---------- Panel (vycentrovaný průsvitný rámeček, žádné vyjíždění zespodu) ---------- */
const openSheets = [];

// Vrací { body, close } — `body` je element k naplnění/překreslení obsahu.
export function openSheet({ title, bodyHtml }) {
  const root = document.getElementById('sheet-root');
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  bd.innerHTML = `
    <div class="sheet" role="dialog" aria-label="${escapeHtml(title)}">
      <div class="sheet-head">
        <h2 class="sheet-title">${escapeHtml(title)}</h2>
        <button class="sheet-close" aria-label="Zavřít">${ICON.close}</button>
      </div>
      <div class="sheet-body"></div>
    </div>`;
  root.appendChild(bd);
  const body = bd.querySelector('.sheet-body');
  body.innerHTML = bodyHtml;
  lockScroll();

  let closed = false;
  const api = {
    body,
    close() {
      if (closed) return;
      closed = true;
      unlockScroll();
      const i = openSheets.indexOf(api);
      if (i >= 0) openSheets.splice(i, 1);
      bd.classList.add('closing');
      setTimeout(() => { bd.remove(); refreshTopEdge(); }, 220);
    }
  };
  openSheets.push(api);

  bd.querySelector('.sheet-close').addEventListener('click', api.close);
  bd.addEventListener('click', e => { if (e.target === bd) api.close(); });

  return api;
}

export function closeAllSheets() {
  [...openSheets].forEach(s => s.close());
}

/* ---------- Výběr hvězdiček (včetně půlek, dotyk i myš) ---------- */
export function createStarPicker(container, { value = 0, onChange } = {}) {
  let val = value;
  container.innerHTML = `
    <div class="star-picker">
      ${[1, 2, 3, 4, 5].map(i => `<span class="sp-star" data-i="${i}">★<span class="sp-fill">★</span></span>`).join('')}
    </div>
    <div class="star-picker-val"></div>`;
  const picker = container.querySelector('.star-picker');
  const valEl = container.querySelector('.star-picker-val');

  function render() {
    picker.querySelectorAll('.sp-star').forEach(st => {
      const i = +st.dataset.i;
      const fill = st.querySelector('.sp-fill');
      fill.style.width = val >= i ? '100%' : (val >= i - 0.5 ? '50%' : '0');
    });
    valEl.textContent = val > 0 ? `${String(val).replace('.', ',')} z 5` : 'Klepni na hvězdičky';
  }

  function setFromPoint(clientX) {
    const stars = [...picker.querySelectorAll('.sp-star')];
    for (const st of stars) {
      const r = st.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        const half = clientX < r.left + r.width / 2;
        val = +st.dataset.i - (half ? 0.5 : 0);
        render();
        onChange && onChange(val);
        return;
      }
    }
    // mimo hvězdy: doleva = minimum, doprava = 5
    const first = stars[0].getBoundingClientRect();
    if (clientX < first.left) { val = 0.5; render(); onChange && onChange(val); }
    const last = stars[4].getBoundingClientRect();
    if (clientX > last.right) { val = 5; render(); onChange && onChange(val); }
  }

  picker.addEventListener('click', e => setFromPoint(e.clientX));
  picker.addEventListener('touchmove', e => {
    e.preventDefault();
    setFromPoint(e.touches[0].clientX);
  }, { passive: false });

  render();
  return { get value() { return val; }, set value(v) { val = v; render(); } };
}
