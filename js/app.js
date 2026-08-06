// Hlavní logika aplikace: stav, synchronizace s Firebase, router a vykreslování stránek.
import {
  db, storage, collection, doc, getDoc, setDoc, deleteDoc, onSnapshot, writeBatch,
  ref, uploadString, getDownloadURL, deleteObject
} from './firebase.js';
import {
  UNITS, DEFAULT_CATS, catInitial, uid, norm, escapeHtml, avgRating, scaleQty,
  formatTime, formatDate, starsText, ingredientMatch, compressImage,
  aiPromptText,
  STORE_CATEGORIES, classifyIngredient
} from './util.js';
import {
  showLoader, hideLoader, toast, confirmDialog, alertDialog, promptDialog,
  openSheet, closeAllSheets, createStarPicker
} from './ui.js';
import {
  watchAuthState, showAuthGate, hideAuthGate, signOutUser, currentDisplayName, currentUid,
  changeDisplayName, changePassword, addAllowedEmail, removeAllowedEmail, hasPasswordProvider
} from './auth.js';

const FEEDBACK_EMAIL = 'kubin.luk@gmail.com';

// Demo režim (?demo=1): ukázková data jen v paměti, do cloudu se nic nezapisuje.
// Mutable: host bez přístupu ke cloudu do něj spadne automaticky (viz guestDemoFallback níže).
const URL_DEMO = new URLSearchParams(location.search).has('demo');
let DEMO = URL_DEMO;
// Veřejný náhled sdíleného receptu (bez přihlášení) — jen ten jeden recept, bez nav chromu.
let publicMode = false;
// Host: prohlížení celé kuchařky bez přihlášení, ale bez možnosti cokoli přidat/upravit/komentovat.
let guestMode = false;
// Host narazil na to, že cloud ještě není nastavený (pravidla neumožňují číst bez účtu) ->
// appka mu místo prázdné/zamčené obrazovky pustí ukázková data, aby si měl na čem zkoušet appku.
let guestDemoFallback = false;
function readOnly() { return publicMode || guestMode; }
function myName() { return DEMO ? (state.profiles[0] || 'Ty') : currentDisplayName(); }
// Vlastnictví obsahu (recept, hodnocení): primárně podle uid autora (nové záznamy
// ho nesou v `authorUid`), u starších záznamů fallback na shodu jména. Upravovat
// a mazat smí jen autor — ostatní uživatelé recept jen čtou a hodnotí.
function isMine(x) {
  if (!x) return false;
  const me = currentUid();
  if (x.authorUid && me) return x.authorUid === me;
  return !!x.author && x.author === myName();
}
function canEditRecipe(r) { return !readOnly() && isMine(r); }

/* ================= Stav ================= */
const state = {
  recipes: [],
  categories: [],
  catStyles: {},             // { název: { color: 0-8, emoji: "🍲" } } — stranou kvůli kompatibilitě se starou verzí
  avatarPhotos: {},          // { jméno: url } — profilové fotky sdílené přes cloud (stranou, jako catStyles)
  profiles: [],
  allowedEmails: [],
  loaded: false,
  sortMode: 'newest',       // 'newest' | 'alpha' | 'best'
  profileFilter: [],
  timeFilter: 'all',        // 'all' | '30' | '60' | '120' | '120+'
  searchQuery: '',
  searchMode: 'name',       // 'name' | 'ingredients'
  shopping: [],             // [{ id, text, cat, done }]
  shoppingSort: 'store',    // 'store' (podle obchodu) | 'added' (v pořadí přidání)
  highScores: {},           // { jméno: nejvyšší skóre } — žebříček minihry (stranou, jako catStyles)
  accessRequests: [],       // [{ uid, email, name }] — kdo se přihlásil a čeká na pozvání
};

let profilesAutoCreated = false;

/* ================= Vzhled (světlý/tmavý/systém) ================= */
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
function getThemePref() { return localStorage.getItem('kucharka-theme') || 'system'; }
function applyTheme() {
  const pref = getThemePref();
  const dark = pref === 'dark' || (pref === 'system' && mqDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
mqDark.addEventListener('change', applyTheme);
applyTheme();
state.shoppingSort = localStorage.getItem('kucharka-shopping-sort') || 'store';

/* ================= Data — Firebase ================= */
function loadDemoData() {
  loadShoppingLocal();
  state.categories = [...DEFAULT_CATS, 'Mořské plody'];
  state.catStyles = {
    'Polévky': { color: 3, emoji: '🍲' },
    'Hlavní jídla': { color: 5, emoji: '🍽️' },
    'Dezerty': { color: 6, emoji: '🍰' },
    'Mořské plody': { color: 4, emoji: '🦪' },
  };
  state.profiles = ['Lukáš', 'Eva', 'Petr'];
  const now = Date.now(), day = 86400000;
  state.recipes = [
    {
      id: 'demo1', name: 'Hovězí guláš', category: 'Hlavní jídla', author: 'Petr',
      cookTime: 150, portions: 4, photo: '',
      ingredients: [
        { qty: '800', unit: 'g', name: 'hovězí kližka' },
        { qty: '4', unit: 'počet', name: 'velké cibule' },
        { qty: '2', unit: 'lžíce', name: 'sladká paprika' },
        { qty: '1', unit: 'lžička', name: 'majoránka' },
        { qty: '500', unit: 'ml', name: 'hovězí vývar' },
      ],
      steps: ['Cibuli nakrájej nadrobno a zpěň dozlatova.', 'Přidej maso a zprudka orestuj.', 'Zapraš paprikou, zalij vývarem a duš doměkka 2 hodiny.', 'Dochuť majoránkou, česnekem a solí.'],
      reviews: [
        { id: 'rv1', author: 'Eva', stars: 5, comment: 'Nejlepší guláš, jaký znám!', createdAt: now - 9 * day },
        { id: 'rv2', author: 'Lukáš', stars: 4.5, comment: 'Příště trochu pálivější.', createdAt: now - 3 * day },
      ],
      createdAt: now - 40 * day, updatedAt: now - 3 * day,
    },
    {
      id: 'demo2', name: 'Kuřecí polévka s nudlemi', category: 'Polévky', author: 'Eva',
      cookTime: 45, portions: 6, photo: '',
      ingredients: [
        { qty: '1', unit: 'počet', name: 'kuřecí skelet' },
        { qty: '3', unit: 'počet', name: 'mrkve' },
        { qty: '100', unit: 'g', name: 'nudle' },
      ],
      steps: ['Skelet zalij vodou a vař 30 minut.', 'Přidej zeleninu.', 'Sceď, přidej nudle a maso.'],
      reviews: [{ id: 'rv3', author: 'Petr', stars: 4, comment: '', createdAt: now - day }],
      createdAt: now - 10 * day,
    },
    {
      id: 'demo3', name: 'Palačinky', category: 'Dezerty', author: 'Lukáš',
      cookTime: 25, portions: 2, photo: '',
      ingredients: [
        { qty: '250', unit: 'g', name: 'hladká mouka' },
        { qty: '500', unit: 'ml', name: 'mléko' },
        { qty: '2', unit: 'počet', name: 'vejce' },
        { qty: '1', unit: '—', name: 'špetka soli' },
      ],
      steps: ['Umíchej těsto bez hrudek.', 'Smaž z obou stran dozlatova.', 'Namaž marmeládou a sroluj.'],
      reviews: [],
      createdAt: now - 2 * day,
    },
    {
      // ukázka receptu ve víc kategoriích: patří pod Polévky i Mořské plody
      id: 'demo4', name: 'Polévka z mušlí', categories: ['Polévky', 'Mořské plody'], author: 'Eva',
      cookTime: 40, portions: 4, photo: '',
      ingredients: [
        { qty: '1', unit: 'kg', name: 'mušle' },
        { qty: '2', unit: 'lžíce', name: 'máslo' },
        { qty: '200', unit: 'ml', name: 'bílé víno' },
        { qty: '200', unit: 'ml', name: 'smetana' },
        { qty: '2', unit: 'počet', name: 'stroužky česneku' },
      ],
      steps: ['Mušle důkladně omyj a odstraň vousky.', 'Na másle orestuj česnek, zalij vínem a přiveď k varu.', 'Přidej mušle, poklop a duš 5 minut, dokud se neotevřou.', 'Vmíchej smetanu a dochuť.'],
      reviews: [{ id: 'rv4', author: 'Petr', stars: 5, comment: 'Chuť jako u moře.', createdAt: now - 5 * day }],
      createdAt: now - 5 * day,
    },
  ];
  state.loaded = true;
  renderProfileButtons();  // jméno v demu je známé až tady (profiles[0])
  onDataChanged();
}

function subscribe() {
  if (DEMO) { loadDemoData(); return; }

  onSnapshot(doc(db, 'meta', 'categories'), d => {
    state.categories = (d.exists() && d.data().list) ? d.data().list : [...DEFAULT_CATS];
    onDataChanged();
  }, err => console.error('categories sync:', err));

  onSnapshot(doc(db, 'meta', 'profiles'), d => {
    state.profiles = (d.exists() && d.data().list) ? d.data().list : [];
  }, err => console.error('profiles sync:', err));

  if (!guestMode) {
    onSnapshot(doc(db, 'meta', 'allowedEmails'), d => {
      state.allowedEmails = (d.exists() && d.data().list) ? d.data().list : [];
      if (currentRoute?.page === 'settings') renderSettingsPage();
    }, err => console.error('allowedEmails sync:', err));
    subscribeShopping();
  } else {
    loadShoppingLocal();  // host bez účtu: seznam jen lokálně v prohlížeči
  }

  // vzhled kategorií (barva + emoji) — samostatný dokument, aby ho stará verze nepřepsala
  onSnapshot(doc(db, 'meta', 'catStyles'), d => {
    state.catStyles = (d.exists() && d.data().map) ? d.data().map : {};
    onDataChanged();
  }, err => console.error('catStyles sync:', err));

  // profilové fotky (jméno -> url), sdílené přes cloud — aby je viděli i ostatní
  // u svých hodnocení. Vlastní fotku máme i lokálně (instant/offline), viz photoFor.
  onSnapshot(doc(db, 'meta', 'avatarPhotos'), d => {
    state.avatarPhotos = (d.exists() && d.data().map) ? d.data().map : {};
    renderProfileButtons();
    onDataChanged();
  }, err => console.error('avatarPhotos sync:', err));

  // žádosti o přístup — kdo se přihlásil, ale ještě není na seznamu pozvaných
  onSnapshot(collection(db, 'accessRequests'), snap => {
    state.accessRequests = [];
    snap.forEach(d => state.accessRequests.push({ ...d.data(), uid: d.id }));
    onDataChanged();
  }, err => console.error('accessRequests sync:', err));

  // žebříček minihry (jméno -> nejvyšší skóre), sdílený přes cloud
  onSnapshot(doc(db, 'meta', 'highScores'), d => {
    state.highScores = (d.exists() && d.data().map) ? d.data().map : {};
    onDataChanged();
  }, err => console.error('highScores sync:', err));

  onSnapshot(collection(db, 'recipes'), snap => {
    state.recipes = [];
    snap.forEach(d => state.recipes.push({ ...d.data(), id: d.id }));
    state.loaded = true;
    autoCreateProfiles();
    onDataChanged();
  }, err => {
    console.error('recipes sync:', err);
    if (!DEMO && err.code === 'permission-denied') {
      if (guestMode) {
        // Host nemá do kuchařky přístup (pravidla pouštějí jen pozvané) -> místo
        // prázdné/zamčené obrazovky mu pustíme ukázková data, ať appku vidí v chodu.
        guestMode = false;
        guestDemoFallback = true;
        DEMO = true;
        document.body.classList.remove('public-view');
        showGuestBanner('Ukázková data — kuchařka je jen pro pozvané', 'Přihlásit se');
        loadDemoData();
        toast('Kuchařka je jen pro pozvané — zatím se koukáš na ukázková data');
      } else {
        showAuthGate('pending-access');
      }
      return;
    }
    state.loaded = true;
    onDataChanged();
    alertDialog('Chyba připojení', 'Nepodařilo se načíst data z cloudu. Zkontroluj připojení k internetu.');
  });
}

// Jméno přihlášeného uživatele bez profilu -> profil se doplní automaticky (jen jednou po načtení).
function autoCreateProfiles() {
  if (profilesAutoCreated || guestMode) return;
  profilesAutoCreated = true;
  const missing = new Set();
  const me = myName();
  if (me && !state.profiles.includes(me)) missing.add(me);
  state.recipes.forEach(r => {
    const a = (r.author || '').trim();
    if (a && !state.profiles.includes(a)) missing.add(a);
  });
  if (missing.size) {
    state.profiles = [...state.profiles, ...missing];
    saveProfiles();
  }
}

function saveCategories() {
  if (DEMO) return Promise.resolve();
  return setDoc(doc(db, 'meta', 'categories'), { list: state.categories })
    .catch(e => { console.error(e); toast('Kategorie se nepodařilo uložit'); });
}

function saveCatStyles() {
  if (DEMO) return Promise.resolve();
  return setDoc(doc(db, 'meta', 'catStyles'), { map: state.catStyles })
    .catch(e => { console.error(e); toast('Vzhled kategorií se nepodařilo uložit'); });
}

function saveAvatarPhotos() {
  if (DEMO) return Promise.resolve();
  return setDoc(doc(db, 'meta', 'avatarPhotos'), { map: state.avatarPhotos })
    .catch(e => { console.error(e); toast('Profilovou fotku se nepodařilo uložit'); });
}

// Uloží skóre, jen když překonává dosavadní osobní rekord. Vrací true při rekordu.
// V demu (a bez přihlášení) zůstane žebříček jen v paměti prohlížeče.
function saveHighScore(name, score) {
  if (!name || !(score > 0)) return false;
  const best = state.highScores[name] || 0;
  if (score <= best) return false;
  state.highScores = { ...state.highScores, [name]: score };
  if (!DEMO) {
    setDoc(doc(db, 'meta', 'highScores'), { map: state.highScores })
      .catch(e => { console.error(e); toast('Skóre se nepodařilo uložit'); });
  }
  return true;
}

function saveProfiles() {
  if (DEMO) return Promise.resolve();
  return setDoc(doc(db, 'meta', 'profiles'), { list: state.profiles })
    .catch(e => { console.error(e); toast('Profily se nepodařilo uložit'); });
}

/* ================= Nákupní seznam: data ================= */
// Osobní seznam. Přihlášený: Firestore shoppingLists/{uid}. Demo/host: jen localStorage.
const SHOPPING_LOCAL_KEY = 'kucharka-shopping-local';

function loadShoppingLocal() {
  try { state.shopping = JSON.parse(localStorage.getItem(SHOPPING_LOCAL_KEY) || '[]'); }
  catch { state.shopping = []; }
}

function shoppingIsLocal() { return DEMO || guestMode || !currentUid(); }

function saveShopping() {
  if (shoppingIsLocal()) {
    try { localStorage.setItem(SHOPPING_LOCAL_KEY, JSON.stringify(state.shopping)); } catch { /* plná kvóta */ }
    return Promise.resolve();
  }
  return setDoc(doc(db, 'shoppingLists', currentUid()), { items: state.shopping })
    .catch(e => { console.error('save shopping:', e); toast('Nákupní seznam se nepodařilo uložit'); });
}

function subscribeShopping() {
  const uidNow = currentUid();
  if (!uidNow) return;
  onSnapshot(doc(db, 'shoppingLists', uidNow), d => {
    state.shopping = (d.exists() && Array.isArray(d.data().items)) ? d.data().items : [];
    if (currentRoute?.page === 'shopping') renderShoppingPage();
  }, err => console.error('shopping sync:', err));
}

// Přidání volné položky (uživatel si napíše, co chce).
function addShoppingItem(text) {
  const t = (text || '').trim();
  if (!t) return;
  state.shopping.push({ id: uid(), text: t, cat: classifyIngredient(t), done: false });
  saveShopping();
}

// Přidání ingrediencí z receptu (přepočtených na porce) rovnou do seznamu.
function addRecipeToShopping(r, mult) {
  const items = (r.ingredients || []).filter(i => i.name).map(i => {
    const q = scaleQty(i.qty, mult);
    const u = i.unit && i.unit !== '—' && i.unit !== 'počet' ? i.unit : '';
    const qtyPart = [q, u].filter(Boolean).join(' ');
    const text = qtyPart ? `${i.name} (${qtyPart})` : i.name;
    return { id: uid(), text, cat: classifyIngredient(i.name), done: false };
  });
  if (!items.length) return 0;
  state.shopping.push(...items);
  saveShopping();
  return items.length;
}

async function saveRecipe(recipe) {
  if (DEMO) {
    const i = state.recipes.findIndex(r => r.id === recipe.id);
    if (i >= 0) state.recipes[i] = recipe; else state.recipes.push(recipe);
    onDataChanged();
    return true;
  }
  showLoader('Ukládám…');
  try {
    const data = { ...recipe };
    const id = data.id;
    delete data.id;
    if (data.photo && data.photo.startsWith('data:')) {
      const photoRef = ref(storage, 'photos/' + id + '.jpg');
      // Bez tohohle posílá Firebase `max-age=0` a fotka se stahuje při každém
      // zobrazení znovu. Dlouhá platnost je bezpečná: při KAŽDÉM nahrání dostane
      // soubor nový přístupový token, takže `getDownloadURL` níž vrátí JINOU
      // adresu, uloží ji do receptu a všem se tím fotka přirozeně obnoví.
      await uploadString(photoRef, data.photo, 'data_url', { cacheControl: 'public, max-age=31536000' });
      data.photo = await getDownloadURL(photoRef);
    }
    await setDoc(doc(db, 'recipes', id), data);
    hideLoader();
    return true;
  } catch (e) {
    console.error('save recipe:', e);
    hideLoader();
    await alertDialog('Chyba při ukládání', 'Recept se nepodařilo uložit. Zkontroluj připojení.');
    return false;
  }
}

async function deleteRecipe(id) {
  if (DEMO) {
    state.recipes = state.recipes.filter(r => r.id !== id);
    onDataChanged();
    return true;
  }
  showLoader('Mažu…');
  try {
    try { await deleteObject(ref(storage, 'photos/' + id + '.jpg')); } catch { /* fotka nemusí existovat */ }
    await deleteDoc(doc(db, 'recipes', id));
    hideLoader();
    return true;
  } catch (e) {
    console.error('delete recipe:', e);
    hideLoader();
    await alertDialog('Chyba při mazání', 'Recept se nepodařilo smazat.');
    return false;
  }
}

// Při přejmenování se přenese i klíč profilové fotky (mapa je podle jména).
// Vrací true, když se něco změnilo (aby volající věděl, zda uložit).
function renameAvatarPhotoKey(oldName, newName) {
  if (!state.avatarPhotos[oldName] || oldName === newName) return false;
  const m = { ...state.avatarPhotos };
  m[newName] = m[oldName];
  delete m[oldName];
  state.avatarPhotos = m;
  return true;
}

// Přejmenování profilu se propíše do všech receptů i recenzí.
async function renameProfileEverywhere(oldName, newName) {
  if (DEMO) {
    state.profiles = state.profiles.map(p => p === oldName ? newName : p);
    state.recipes.forEach(r => {
      if (r.author === oldName) r.author = newName;
      (r.reviews || []).forEach(rv => { if (rv.author === oldName) rv.author = newName; });
    });
    renameAvatarPhotoKey(oldName, newName);
    onDataChanged();
    toast(`Profil přejmenován na „${newName}"`);
    return;
  }
  showLoader('Přejmenovávám…');
  try {
    state.profiles = state.profiles.map(p => p === oldName ? newName : p);
    await saveProfiles();
    if (renameAvatarPhotoKey(oldName, newName)) await saveAvatarPhotos();
    const batch = writeBatch(db);
    let dirty = 0;
    state.recipes.forEach(r => {
      let changed = false;
      const upd = {};
      if (r.author === oldName) { upd.author = newName; changed = true; }
      if ((r.reviews || []).some(rv => rv.author === oldName)) {
        upd.reviews = r.reviews.map(rv => rv.author === oldName ? { ...rv, author: newName } : rv);
        changed = true;
      }
      if (changed) { batch.update(doc(db, 'recipes', r.id), upd); dirty++; }
    });
    if (dirty) await batch.commit();
    hideLoader();
    toast(`Profil přejmenován na „${newName}"`);
  } catch (e) {
    console.error('rename profile:', e);
    hideLoader();
    alertDialog('Chyba', 'Přejmenování se nepodařilo dokončit.');
  }
}

function withoutCategory(r, cat) {
  return { categories: recipeCategories(r).filter(c => c !== cat) };
}
function withRenamedCategory(r, oldName, newName) {
  return { categories: recipeCategories(r).map(c => c === oldName ? newName : c) };
}

// Smazání kategorie: recepty zůstanou, jen přijdou o tohle zařazení (ostatní kategorie,
// pokud recept měl víc, zůstávají beze změny).
async function deleteCategoryEverywhere(cat) {
  const hadStyle = !!state.catStyles[cat];
  if (state.catStyles[cat]) delete state.catStyles[cat];
  if (DEMO) {
    state.categories = state.categories.filter(c => c !== cat);
    state.recipes.forEach(r => {
      if (recipeCategories(r).includes(cat)) Object.assign(r, withoutCategory(r, cat));
    });
    onDataChanged();
    toast(`Kategorie „${cat}" smazána`);
    return;
  }
  showLoader('Mažu kategorii…');
  try {
    state.categories = state.categories.filter(c => c !== cat);
    await saveCategories();
    if (hadStyle) await saveCatStyles();
    const batch = writeBatch(db);
    let dirty = 0;
    state.recipes.forEach(r => {
      if (recipeCategories(r).includes(cat)) { batch.update(doc(db, 'recipes', r.id), withoutCategory(r, cat)); dirty++; }
    });
    if (dirty) await batch.commit();
    hideLoader();
    toast(`Kategorie „${cat}" smazána`);
  } catch (e) {
    console.error('delete category:', e);
    hideLoader();
    alertDialog('Chyba', 'Kategorii se nepodařilo smazat.');
  }
}

// Přejmenování kategorie se propíše do pořadí i do všech receptů, které ji používají
// (i těch, které mají přiřazenou víc než jednu kategorii).
async function renameCategoryEverywhere(oldName, newName) {
  // přenést vzhled na nový klíč
  if (state.catStyles[oldName]) { state.catStyles[newName] = state.catStyles[oldName]; delete state.catStyles[oldName]; }
  if (DEMO) {
    state.categories = state.categories.map(c => c === oldName ? newName : c);
    state.recipes.forEach(r => {
      if (recipeCategories(r).includes(oldName)) Object.assign(r, withRenamedCategory(r, oldName, newName));
    });
    onDataChanged();
    return;
  }
  showLoader('Přejmenovávám…');
  try {
    state.categories = state.categories.map(c => c === oldName ? newName : c);
    await saveCategories();
    await saveCatStyles();
    const batch = writeBatch(db);
    let dirty = 0;
    state.recipes.forEach(r => {
      if (recipeCategories(r).includes(oldName)) { batch.update(doc(db, 'recipes', r.id), withRenamedCategory(r, oldName, newName)); dirty++; }
    });
    if (dirty) await batch.commit();
    hideLoader();
    toast(`Přejmenováno na „${newName}"`);
  } catch (e) {
    console.error('rename category:', e);
    hideLoader();
    alertDialog('Chyba', 'Kategorii se nepodařilo přejmenovat.');
  }
}

/* ================= Odvozená data ================= */
// Recept může patřit do víc kategorií (pole `categories`). Staré recepty bez tohoto
// pole (z doby před touto funkcí) mají jen `category` — bere se jako kategorie jedna.
function recipeCategories(r) {
  if (Array.isArray(r.categories) && r.categories.length) return r.categories;
  return r.category ? [r.category] : [];
}
// „Hlavní" kategorie receptu — určuje barvu/emoji miniatury.
function primaryCategory(r) { return recipeCategories(r)[0] || ''; }

function catCount(key) {
  if (key === 'all') return state.recipes.length;
  if (key === 'none') return state.recipes.filter(r => recipeCategories(r).length === 0).length;
  return state.recipes.filter(r => recipeCategories(r).includes(key)).length;
}

function passesFilters(r) {
  if (state.profileFilter.length && !state.profileFilter.includes(r.author)) return false;
  if (state.timeFilter !== 'all') {
    const t = parseInt(r.cookTime) || 0;
    if (state.timeFilter === '120+') return t > 120;
    return t > 0 && t <= +state.timeFilter;
  }
  return true;
}

function sortList(list) {
  const l = [...list];
  if (state.sortMode === 'alpha') l.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'cs'));
  else if (state.sortMode === 'best') l.sort((a, b) => avgRating(b.reviews) - avgRating(a.reviews));
  else l.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return l;
}

function listingRecipes(catKey) {
  let list = state.recipes;
  if (catKey === 'none') list = list.filter(r => recipeCategories(r).length === 0);
  else if (catKey !== 'all') list = list.filter(r => recipeCategories(r).includes(catKey));
  return sortList(list.filter(passesFilters));
}

function searchResults() {
  const q = norm(state.searchQuery);
  if (!q) return null;
  if (state.searchMode === 'name') {
    return sortList(state.recipes.filter(r => norm(r.name).includes(q) && passesFilters(r)));
  }
  const tokens = q.split(',').map(t => t.trim()).filter(Boolean);
  if (!tokens.length) return [];
  return state.recipes
    .map(r => ({ r, m: ingredientMatch(r, tokens) }))
    .filter(x => x.m.matched > 0 && passesFilters(x.r))
    .sort((a, b) => b.m.matched - a.m.matched || avgRating(b.r.reviews) - avgRating(a.r.reviews))
    .map(x => ({ ...x.r, _match: x.m }));
}

function filterCount() {
  return state.profileFilter.length + (state.timeFilter !== 'all' ? 1 : 0);
}

// Vlastní barva se ukládá jako hex řetězec ("#RRGGBB"), předvolba jako celé číslo 0-8.
function darkenHex(hex, amt = 0.4) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amt));
  const g = Math.round(((n >> 8) & 255) * (1 - amt));
  const b = Math.round((n & 255) * (1 - amt));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// CSS třída gradientové dlaždice: prázdný řetězec, pokud kategorie má vlastní (hex) barvu
function catGrad(name) {
  const c = state.catStyles[name] && state.catStyles[name].color;
  if (typeof c === 'string' && c[0] === '#') return '';
  if (Number.isInteger(c)) return 'g' + c;
  if (name === '__all') return 'g0';
  if (name === '__none') return 'g8';
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'g' + (1 + h % 7);
}

// Inline styl pro vlastní (hex) barvu; prázdný řetězec, pokud se používá předvolba (CSS třída).
function catColorStyle(name) {
  const c = state.catStyles[name] && state.catStyles[name].color;
  if (typeof c === 'string' && c[0] === '#') return `background:linear-gradient(135deg,${c},${darkenHex(c)})`;
  return '';
}

// glyf dlaždice/miniatury: emoji kategorie, jinak počáteční písmeno
function catGlyph(name) {
  const e = state.catStyles[name] && state.catStyles[name].emoji;
  return e || catInitial(name);
}
// pro recept: emoji jeho HLAVNÍ kategorie (má-li), jinak písmeno z kategorie/názvu
function recipeGlyph(r) {
  const cat = primaryCategory(r);
  const e = cat && state.catStyles[cat] && state.catStyles[cat].emoji;
  return e || catInitial(cat || r.name);
}
// je glyf emoji? (kvůli velikosti písma – serif písmeno vs emoji)
function isEmojiGlyph(g) { return !!g && /\p{Extended_Pictographic}/u.test(g); }

function fmtAvg(avg) { return String(Math.round(avg * 10) / 10).replace('.', ','); }

/* ================= Komponenty ================= */
// Kategorie k zobrazení jako kicker: v pohledu na konkrétní kategorii se ta samotná
// vynechá (nemá smysl psát „POLÉVKY" u receptu, který si právě v Polévkách prohlížíš) —
// ale zůstanou ostatní, takže u polévky z mušlí uvidíš i „MOŘSKÉ PLODY".
function displayCategoriesFor(r, currentCat) {
  const cats = recipeCategories(r);
  if (!currentCat || currentCat === 'all' || currentCat === 'none') return cats;
  return cats.filter(c => c !== currentCat);
}

function rowHtml(r, { currentCat = null } = {}) {
  const avg = avgRating(r.reviews);
  const meta = [];
  if (r.cookTime) meta.push(escapeHtml(formatTime(r.cookTime)));
  if (r.portions) meta.push(`${escapeHtml(String(r.portions))} porcí`);
  if (avg) meta.push(`<span class="st">★ ${fmtAvg(avg)}</span>`);
  const cats = displayCategoriesFor(r, currentCat);
  const pCat = primaryCategory(r);
  return `
  <a class="row" href="#/recept/${escapeHtml(r.id)}">
    ${r.photo
      ? `<img class="row-thumb" src="${escapeHtml(r.photo)}" alt="" loading="lazy">`
      : `<div class="row-thumb-ph ${catGrad(pCat || '__none')}${isEmojiGlyph(recipeGlyph(r)) ? ' is-emoji' : ''}" style="${catColorStyle(pCat || '__none')}">${recipeGlyph(r)}</div>`}
    <div class="row-body">
      ${cats.length ? `<div class="row-kicker">${cats.map(escapeHtml).join(' · ')}</div>` : ''}
      <div class="row-name">${escapeHtml(r.name)}</div>
      <div class="row-meta">${meta.join(' · ')}</div>
    </div>
    ${r._match ? `<span class="row-match">✓ ${r._match.matched}/${r._match.total}</span>` : ''}
  </a>`;
}

function shelfCardHtml(r) {
  const avg = avgRating(r.reviews);
  const meta = [];
  if (r.cookTime) meta.push(escapeHtml(formatTime(r.cookTime)));
  if (avg) meta.push(`<span class="st">★ ${fmtAvg(avg)}</span>`);
  const pCat = primaryCategory(r);
  return `
  <a class="shelf-card" href="#/recept/${escapeHtml(r.id)}">
    ${r.photo
      ? `<img class="sc-photo" src="${escapeHtml(r.photo)}" alt="" loading="lazy">`
      : `<div class="sc-ph ${catGrad(pCat || '__none')}${isEmojiGlyph(recipeGlyph(r)) ? ' is-emoji' : ''}" style="${catColorStyle(pCat || '__none')}">${recipeGlyph(r)}</div>`}
    <div class="sc-name">${escapeHtml(r.name)}</div>
    <div class="sc-meta">${meta.join(' · ')}</div>
  </a>`;
}

function activeFiltersHtml() {
  const TIME_LABELS = { '30': 'Do 30 min', '60': 'Do 1 hodiny', '120': 'Do 2 hodin', '120+': 'Přes 2 hodiny' };
  const chips = [];
  state.profileFilter.forEach(p =>
    chips.push(`<span class="afilter">${escapeHtml(p)} <button data-rm-author="${escapeHtml(p)}">✕</button></span>`));
  if (state.timeFilter !== 'all')
    chips.push(`<span class="afilter">${TIME_LABELS[state.timeFilter]} <button data-rm-time="1">✕</button></span>`);
  return chips.length ? `<div class="active-filters">${chips.join('')}</div>` : '';
}

function bindActiveFilters(container, onChange) {
  container.querySelectorAll('[data-rm-author]').forEach(b => b.addEventListener('click', () => {
    state.profileFilter = state.profileFilter.filter(p => p !== b.dataset.rmAuthor);
    onChange();
  }));
  container.querySelectorAll('[data-rm-time]').forEach(b => b.addEventListener('click', () => {
    state.timeFilter = 'all';
    onChange();
  }));
}

const backSvg = `<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const filterSvg = `<svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="7" y1="12" x2="17" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="10" y1="17" x2="14" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const trashSvg = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.4a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6L18 7M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const pencilSvg = `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M4.5 19.5l.9-3.6L16.6 4.7a2.05 2.05 0 0 1 2.9 2.9L8.3 18.8l-3.8.7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
const cameraSvg = `<svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 8.2h2.8l1.6-2.2h7.2l1.6 2.2H20a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.2a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="13.8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;
const dragSvg = `<svg viewBox="0 0 24 24" width="17" height="17"><line x1="4" y1="8" x2="20" y2="8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="4" y1="12.5" x2="20" y2="12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const checkSvg = `<svg class="dot-check" viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const plusSvg = `<svg viewBox="0 0 24 24" width="22" height="22"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const dotsSvg = `<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>`;
const personSvg = `<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
// ikony pro menu akcí receptu (jednotná velikost 21px, tenká linka jako zbytek appky)
const cartSvg = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 8V6.5a5 5 0 0 1 10 0V8m-13.2 0h16.4l-.9 11.4a1.8 1.8 0 0 1-1.8 1.6H6.5a1.8 1.8 0 0 1-1.8-1.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const editSvg = `<svg viewBox="0 0 24 24" width="21" height="21"><path d="M4 20l.9-3.7L15.8 5.4a2 2 0 0 1 2.8 2.8L7.7 19.1 4 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
// Sdílení — přesný tvar SF Symbolu „square.and.arrow.up" z iOS 26/27: šipka nahoru
// procházející úzkým otvorem v horní hraně zaobleného „boxu" (ne dlouhá tenká šipka
// nad širokým podnosem jako dřív). stroke atributy na <svg> dědí obě cesty.
const shareSvg = `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2V14.6"/><path d="M8.5 6.65 12 3.2l3.5 3.45"/><path d="M9.2 8.9H6.6a2.2 2.2 0 0 0-2.2 2.2v7.7A2.2 2.2 0 0 0 6.6 21h10.8a2.2 2.2 0 0 0 2.2-2.2v-7.7a2.2 2.2 0 0 0-2.2-2.2h-2.6"/></svg>`;
// „Nezhasínat displej" (Wake Lock) — slunce jako univerzální „zůstává rozsvíceno"
const sunSvg = `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.9"/><path d="M12 2.8v2.3M12 18.9v2.3M2.8 12h2.3M18.9 12h2.3M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6"/></svg>`;
const aiSvg = `<svg viewBox="0 0 24 24" width="21" height="21"><path d="M11 3.5l1.5 4L16.5 9l-4 1.5L11 14.5 9.5 10.5 5.5 9l4-1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17.5 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="currentColor"/></svg>`;

/* ================= Profil (avatar) =================
   Avatar je bar-button item jako v nativních iOS appkách (App Store, Hudba).
   Existují jen DVĚ instance: `#profile-btn-desktop` (horní navigace, desktop) a
   `#home-avatar` (hlavička Domů — jinde na mobilu není a při scrollu se schová,
   viz updateHomeAvatar). Obě sdílí třídu .profile-avatar-btn. */
const AVATAR_COLORS = ['#4E9159', '#C33764', '#0BA360', '#7F53AC', '#36B3C9', '#E0894E', '#C0392B', '#2E86AB'];
// Barva monogramu pro libovolné jméno (deterministicky z jména), ať má i cizí
// autor u hodnocení konzistentní barvu. Vlastní barvu si lze přebít (localStorage).
function avatarColorFor(name) {
  const seed = (name || 'x');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarColor() {
  return localStorage.getItem('kucharka-avatar-color') || avatarColorFor(currentUid() || myName() || 'x');
}
// Fotka pro dané jméno: pro MĚ nejdřív lokální (instant/offline), pak sdílená z cloudu;
// pro ostatní jen sdílená (state.avatarPhotos, plněná z meta/avatarPhotos). Vlastní
// lokální kopie se ukládá pod klíč localStorage 'kucharka-avatar-photo'.
function avatarPhoto() { return localStorage.getItem('kucharka-avatar-photo') || ''; }
function photoFor(name) {
  if (name && name === myName()) return avatarPhoto() || state.avatarPhotos[name] || '';
  return (name && state.avatarPhotos[name]) || '';
}
function initialOf(name) {
  const n = (name || '').trim();
  return n ? n[0].toLocaleUpperCase('cs') : '';
}
function profileInitial() { return initialOf(myName()); }
// Vnitřek MÉHO avatara (hlavička Domů, horní navigace, hero v nastavení).
function avatarInnerHtml() {
  const photo = photoFor(myName());
  if (photo) return `<img class="avatar-img" src="${escapeHtml(photo)}" alt="">`;
  const init = profileInitial();
  return init ? `<span class="avatar-mono">${escapeHtml(init)}</span>` : personSvg;
}
// Malý kruhový avatar libovolného člověka (u hodnocení, v seznamu profilů).
function personAvatarHtml(name) {
  const photo = photoFor(name);
  const init = initialOf(name);
  if (photo) return `<span class="person-avatar"><img class="avatar-img" src="${escapeHtml(photo)}" alt=""></span>`;
  return `<span class="person-avatar" style="background:${avatarColorFor(name)}">${init ? `<span class="avatar-mono">${escapeHtml(init)}</span>` : ''}</span>`;
}
function avatarBtnHtml(id) {
  return `<button class="circle-btn profile-avatar-btn" id="${id}" aria-label="Profil a nastavení"></button>`;
}
// „+" (nový recept) žije uprostřed spodního tab baru (vzor YouTube) — plovoucí
// „+" vpravo nahoře bylo odstraněno. Na desktopu je „+ Nový recept" v horní navigaci.
// Hřejivá pozvánka „Nový recept" (Domů, prázdné Hledání) — Návrh 2.
function addRecipeCardHtml() {
  return `<a class="add-recipe-card" href="#/novy">
    <span class="arc-plus">${plusSvg}</span>
    <span class="arc-text">
      <span class="arc-title">Nový recept</span>
      <span class="arc-sub">Přidej další do sbírky</span>
    </span>
    <span class="arc-chev">›</span>
  </a>`;
}
// Přeplní vizuál VŠECH aktuálně existujících instancí avatara (horní navigace na
// desktopu, hlavička Domů) — volá se po každém vykreslení stránky a při každé
// změně jména/barvy/přihlášení.
function renderProfileButtons() {
  const init = profileInitial();
  const color = avatarColor();
  const photo = photoFor(myName());
  const inner = avatarInnerHtml();
  document.querySelectorAll('.profile-avatar-btn').forEach(btn => {
    btn.innerHTML = inner;
    // barvu podkladu drží jen monogram (bez fotky a se jménem); fotka i „person"
    // ikona mají vlastní/žádné pozadí
    btn.style.background = (!photo && init) ? color : '';
    btn.classList.toggle('avatar-empty', !photo && !init);
  });
}
// Avatar uvnitř #view (jen Domů) se musí po každém překreslení znovu zapojit —
// starý byl zahozen spolu s view.innerHTML. Trvalá instance v horní navigaci
// (desktop) se zapojuje jen jednou, viz níže.
function wireViewAvatarButtons() {
  view.querySelectorAll('.profile-avatar-btn').forEach(b => b.addEventListener('click', () => { location.hash = '#/nastaveni'; }));
}
document.getElementById('profile-btn-desktop').addEventListener('click', () => { location.hash = '#/nastaveni'; });
// zaškrtnutí v barvě akcentu — pro seznamy na běžném pozadí (ne bílé na barevné tečce)
const checkAccentSvg = `<svg class="row-check" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="11" fill="var(--accent)"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* ================= Router ================= */
const view = document.getElementById('view');
const scrollPos = {};
// Hloubka v rámci appky se ukládá do history.state (per-záznam), ne jako pouhý
// rostoucí čítač — jinak se rozjede při gestu „swipe zpět" (dvěma prsty na
// trackpadu) v Safari: to gesto jde v historii zpět (což by mělo hloubku snížit),
// ale hashchange by čítač naopak zvýšil, takže by pak tlačítko Zpět přeskočilo
// mimo appku a „nevrátilo" uživatele. Se stavem v history.state čte goBack vždy
// skutečnou hloubku aktuálního záznamu. + scrollRestoration:manual, ať Safari při
// gestu nebojuje s naším vlastním obnovením scrollu.
try { history.scrollRestoration = 'manual'; } catch { /* starší prohlížeče */ }
if (!history.state || typeof history.state.kd !== 'number') {
  try { history.replaceState({ ...history.state, kd: 0 }, ''); } catch { /* jen zpevní hloubku, ne kritické */ }
}
let navDepth = (history.state && history.state.kd) || 0;
let lastRoutedHash = location.hash;

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (!a) return { page: 'home' };
  if (a === 'kategorie' && b) return { page: 'listing', cat: decodeURIComponent(b) };
  if (a === 'kategorie') return { page: 'cats' };
  if (a === 'vse') return { page: 'listing', cat: 'all' };
  if (a === 'nezarazene') return { page: 'listing', cat: 'none' };
  if (a === 'hledat') return { page: 'search' };
  if (a === 'nakup') return { page: 'shopping' };
  if (a === 'recept' && b) return { page: 'detail', id: decodeURIComponent(b) };
  if (a === 'novy') return { page: 'editor', id: null };
  if (a === 'upravit' && b) return { page: 'editor', id: decodeURIComponent(b) };
  if (a === 'nastaveni') return { page: 'settings' };
  if (a === 'hra') return { page: 'game' };
  return { page: 'home' };
}

function goBack(fallback = '#/') {
  if (navDepth > 0) history.back();
  else location.hash = fallback;
}

function updateTabs(page, route) {
  // Nový recept (klik na „+") je normální záložka jako Domů/Kategorie — zůstává
  // v tab baru, „+" se zvýrazní jako aktivní. Úprava STÁVAJÍCÍHO receptu (otevřená
  // z „•••" menu detailu) je naopak vnořená obrazovka bez tab baru, jako dřív.
  const isNewRecipe = page === 'editor' && !route.id;
  let tab = { home: 'home', cats: 'cats', listing: 'cats', shopping: 'shopping', search: 'search' }[page] || '';
  if (isNewRecipe) tab = 'add';
  document.querySelectorAll('[data-tab]').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === tab));
  // editace existujícího receptu a nastavení profilu jsou soustředěné obrazovky —
  // tab bar se skryje (jako když iOS schová tab bar u modálních/detailových
  // obrazovek); zároveň se zmenší spodní odsazení #view pod plovoucím barem
  const noTabBar = (page === 'editor' && !isNewRecipe) || page === 'settings' || page === 'game';
  document.getElementById('tabbar-wrap')?.classList.toggle('tabbar-hidden', noTabBar);
  document.body.classList.toggle('no-tabbar', noTabBar);
  positionTabIndicator();
  positionTopnavIndicator();
}

// Zvýraznění v tab baru: skleněná dlaždice přejede na aktivní záložku a přitom se
// kapalinově protáhne (náběžný okraj napřed, zadní dobíhá) — jako v Apple Music iOS 26.
const TAB_LEAD = '.40s cubic-bezier(.3,1.25,.4,1)';        // náběžný okraj — rychleji, s pružinou
const TAB_TRAIL = '.54s cubic-bezier(.32,1.06,.4,1) .02s'; // zadní okraj — pomaleji a s malým zpožděním
function positionTabIndicator() {
  const ind = document.getElementById('tab-indicator');
  const bar = document.getElementById('tabbar');
  if (!ind || !bar) return;
  const active = document.querySelector('#tabbar a.active');
  if (!active) { ind.classList.remove('on'); return; }

  // Kapsle je ŠIRŠÍ než buňka a lehce PŘESAHUJE do sousedních (~114 % šířky buňky) —
  // tak to má Apple i jeho adaptace; užší kapsle přesně na buňku působí utaženě.
  // Na výšku zabírá ~86 % baru (svislé odsazení řeší CSS top/bottom).
  // U KRAJNÍCH záložek se ale ven neroztahuje: musí kopírovat zaoblený konec baru
  // se stejnou mezerou jako nahoře/dole (EDGE_MIN = CSS top/bottom), jinak by kulatý
  // konec kapsle vylezl na kulatý konec baru. Přesah tak zůstane jen dovnitř.
  const barRect = bar.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  const bw = parseFloat(getComputedStyle(bar).borderLeftWidth) || 0;
  const overhang = aRect.width * 0.07;   // ~7 % přes každou stranu -> ~114 % šířky buňky
  const EDGE_MIN = 4;                    // = top/bottom v CSS, ať jsou rohy soustředné
  const left = Math.max(aRect.left - barRect.left - bw - overhang, EDGE_MIN);
  const right = Math.max(barRect.right - aRect.right - bw - overhang, EDGE_MIN);

  const wasOn = ind.classList.contains('on');
  const prevLeft = parseFloat(ind.dataset.left);
  ind.classList.add('on');

  if (wasOn && !isNaN(prevLeft) && Math.abs(prevLeft - left) > 1) {
    // přejezd: náběžný okraj (ve směru pohybu) jede napřed, zadní dobíhá -> protažení
    const movingRight = left > prevLeft;
    ind.style.transition = movingRight
      ? `right ${TAB_LEAD}, left ${TAB_TRAIL}, opacity .2s`
      : `left ${TAB_LEAD}, right ${TAB_TRAIL}, opacity .2s`;
  } else {
    ind.style.transition = 'opacity .22s';   // první zobrazení: jen se objeví na místě
  }
  ind.style.left = left + 'px';
  ind.style.right = right + 'px';
  ind.dataset.left = left;
}
window.addEventListener('resize', positionTabIndicator);

/* Desktopová horní navigace: pod aktivní záložku klouže „pilulka" — stejný princip
   jako mobilní tab bar, ať přepínání sekcí není bez animace. Pozici počítá JS,
   plynulý přejezd zajišťuje CSS transition na left/width. Na mobilu je .topnav
   schovaná (display:none), takže se měření přeskočí. */
function positionTopnavIndicator() {
  const ind = document.getElementById('topnav-indicator');
  const links = document.querySelector('.topnav-links');
  if (!ind || !links) return;
  const active = links.querySelector('a.active');
  if (!active || !links.offsetParent) { ind.classList.remove('on'); return; }  // offsetParent null = skrytá (mobil)
  const lr = links.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  ind.style.left = (ar.left - lr.left) + 'px';
  ind.style.width = ar.width + 'px';
  ind.classList.add('on');
}
window.addEventListener('resize', positionTopnavIndicator);
window.addEventListener('load', positionTopnavIndicator);

/* ===== Plovoucí tlačítka v rozích (mobil) — vzor Apple Podcasts ===== */
// Žádná sbalovací lišta s nadpisem uprostřed. Tlačítka Zpět/profil/„+"/„•••" jsou
// přes CSS FIXNÍ (position:fixed) a zůstávají viditelná i při scrollu dolů.
//
// POZOR: vlastní gesto „swipe od levého okraje zpět" tu ZÁMĚRNĚ NENÍ a nevracet ho.
// Safari i appka přidaná na plochu mají gesto zpět vlastní, takže se vykonaly DVĚ
// navigace naráz a uživatel skončil o dvě obrazovky zpátky (klik na šipku fungoval
// správně, protože ten gesto nespouští). Návrat zpět tedy necháváme na prohlížeči.

// Profilový avatar je JEN na Domů (jinde není vůbec) a JEN když jsi vyjetý nahoře —
// při scrollu dolů se plynule schová. Existuje jen `#home-avatar`, jinde nic neřeší.
function updateHomeAvatar() {
  const av = document.getElementById('home-avatar');
  if (av) av.classList.toggle('hide-scrolled', window.scrollY > 24);
}
window.addEventListener('scroll', updateHomeAvatar, { passive: true });

/* Po zavření klávesnice nechává iOS občas viditelnou plochu posunutou nahoru a
   fixní prvky (tab bar) pak visí výš, než mají. Tohle šťouchnutí přinutí prohlížeč
   plochu přepočítat.
   POZOR: NEZKOUŠET bar po dobu psaní schovávat (třída na body). Vypadá to jako
   dobrý nápad, ale nákupní seznam po přidání položky pole znovu zaostří, takže
   by bar zmizel natrvalo a nešel vrátit. Vyzkoušeno, rozbilo to appku. */
document.addEventListener('focusout', e => {
  if (!e.target.matches('input, textarea, select')) return;
  setTimeout(() => window.scrollTo(0, window.scrollY), 60);
});

let currentRoute = parseRoute();
let editorMounted = false;

function render() {
  currentRoute = parseRoute();
  if (guestMode && currentRoute.page === 'editor') {
    toast('Přihlas se, abys mohl přidat nebo upravit recept');
    location.hash = '#/';
    return;
  }
  closeAllSheets();
  document.querySelectorAll('.menu-backdrop').forEach(m => m.remove());   // zavři „•••"/filtr popover při navigaci
  if (stopGame) { stopGame(); stopGame = null; }   // zastav běžící minihru
  editorMounted = false;
  updateTabs(currentRoute.page, currentRoute);
  switch (currentRoute.page) {
    case 'home': renderHome(); break;
    case 'cats': renderCatsPage(); break;
    case 'listing': renderListing(currentRoute.cat); break;
    case 'search': renderSearchPage(); break;
    case 'shopping': renderShoppingPage(); break;
    case 'detail': renderDetailPage(currentRoute.id); break;
    case 'editor': renderEditorPage(currentRoute.id); break;
    case 'settings': renderSettingsPage(); break;
    case 'game': renderGamePage(); break;
  }
  window.scrollTo(0, scrollPos[location.hash] || 0);
  updateHomeAvatar();   // nastav viditelnost avataru podle obnovené pozice scrollu
  // jemný nájezd obsahu při NAVIGACI (ne při živých překresleních přes
  // onDataChanged/klik na krok — ty volají render*Page přímo, bez animace)
  view.classList.remove('page-enter');
  void view.offsetWidth;   // restart animace
  view.classList.add('page-enter');
}

// Reaguje na hashchange (klik na odkaz) i popstate (tlačítko Zpět / gesto swipe
// zpět). popstate se u hash-navigace pálí ještě před hashchange, takže dedup podle
// posledního vyrenderovaného hashe zajistí jeden render na jednu navigaci.
function onLocationChange() {
  if (location.hash === lastRoutedHash) return;
  scrollPos[lastRoutedHash] = window.scrollY;
  lastRoutedHash = location.hash;
  if (history.state && typeof history.state.kd === 'number') {
    navDepth = history.state.kd;   // zpět/vpřed na už navštívený záznam -> jeho uložená hloubka
  } else {
    navDepth += 1;                 // nová navigace vpřed (klik na odkaz) -> o úroveň hlouběji
    try { history.replaceState({ ...history.state, kd: navDepth }, ''); } catch { /* ok */ }
  }
  render();
}
window.addEventListener('hashchange', onLocationChange);
window.addEventListener('popstate', onLocationChange);

// Živá data dorazila -> obnovit aktuální stránku (šetrně, ať nezmizí rozepsaný text).
function onDataChanged() {
  const y = window.scrollY;
  switch (currentRoute.page) {
    case 'home': renderHome(); break;
    case 'cats': renderCatsPage(); break;
    case 'listing': renderListing(currentRoute.cat); break;
    case 'search': updateSearchResults(); return;
    case 'detail': renderDetailPage(currentRoute.id); break;
    case 'editor': if (!editorMounted) renderEditorPage(currentRoute.id); else return; break;
    case 'settings': renderSettingsPage(); break;
    case 'game': return;   // rozehranou hru nepřekreslovat (restartovala by se)
  }
  window.scrollTo(0, y);
}

/* ================= Domů ================= */
function greeting() {
  const h = new Date().getHours();
  if (h < 4) return 'Noční směna?';
  if (h < 10) return 'Dobré ráno!';
  if (h < 18) return 'Dobrý den!';
  return 'Dobrý večer!';
}
const SUBTITLES = ['Co dnes uvaříš?', 'Na co máš dneska chuť?', 'Jdeme vařit.', 'Co se dnes vaří?', 'Uvař něco dobrého.'];
function daySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
// Recept dne: každý den jiný, pro všechny uživatele stejný.
// Hash datumu určí pořadí, které působí náhodně, ale během cyklu se recepty neopakují.
function recipeOfTheDay() {
  const pool = state.recipes.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (!pool.length) return null;
  const h = (Math.imul(daySeed(), 2654435761) >>> 0) % pool.length;
  return pool[h];
}

function greetingRowHtml(titleHtml) {
  return `
    <div class="page-topbar page-topbar-avatar-only"><span class="spacer"></span>${avatarBtnHtml('home-avatar')}</div>
    <div class="greeting"><div class="kicker">${greeting()}</div><h1>${titleHtml}</h1></div>`;
}

function renderHome() {
  if (!state.loaded) {
    view.innerHTML = `
      ${greetingRowHtml('Načítám kuchařku…')}
      <div class="skel-hero"></div>
      <div class="row-list">${'<div class="skel-row"><div class="sk-thumb"></div><div class="sk-lines"><div class="sk-line"></div><div class="sk-line short"></div></div></div>'.repeat(3)}</div>`;
    wireViewAvatarButtons(); renderProfileButtons();
    return;
  }

  if (!state.recipes.length) {
    view.innerHTML = `
      ${greetingRowHtml(SUBTITLES[daySeed() % SUBTITLES.length])}
      <div class="empty">
        <h3>Kuchařka je zatím prázdná</h3>
        <p>Přidej první recept a začni sbírku.</p>
        <a class="btn btn-primary" href="#/novy">Přidat recept</a>
      </div>`;
    wireViewAvatarButtons(); renderProfileButtons();
    return;
  }

  const hero = recipeOfTheDay();
  const heroAvg = avgRating(hero.reviews);

  const newest = sortList(state.recipes).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 12);
  const best = state.recipes.filter(r => avgRating(r.reviews) > 0)
    .sort((a, b) => avgRating(b.reviews) - avgRating(a.reviews)).slice(0, 12);
  const cats = state.categories.filter(c => catCount(c) > 0);

  view.innerHTML = `
    ${greetingRowHtml(SUBTITLES[daySeed() % SUBTITLES.length])}

    <a class="hero" href="#/recept/${escapeHtml(hero.id)}">
      ${hero.photo
        ? `<img src="${escapeHtml(hero.photo)}" alt="">`
        : `<div class="hero-ph ${catGrad(primaryCategory(hero) || '__none')}${isEmojiGlyph(recipeGlyph(hero)) ? ' is-emoji' : ''}" style="position:absolute;inset:0;${catColorStyle(primaryCategory(hero) || '__none')}">${recipeGlyph(hero)}</div>`}
      <div class="scrim"></div>
      <span class="hero-sticker">Recept dne</span>
      <div class="hero-body">
        <h2>${escapeHtml(hero.name)}</h2>
        <div class="hero-meta">
          ${recipeCategories(hero).map(c => `<span class="hero-pill">${escapeHtml(c)}</span>`).join('')}
          ${hero.cookTime ? `<span class="hero-pill">${formatTime(hero.cookTime)}</span>` : ''}
          ${heroAvg ? `<span class="hero-pill">★ ${fmtAvg(heroAvg)}</span>` : ''}
        </div>
      </div>
    </a>

    ${newest.length ? `
    <section class="shelf">
      <div class="shelf-head">
        <h2>Nejnovější</h2>
        <div class="shelf-tools">
          <a href="#/vse">Zobrazit vše</a>
          <button class="shelf-btn" data-scroll="-1" aria-label="Posunout doleva">‹</button>
          <button class="shelf-btn" data-scroll="1" aria-label="Posunout doprava">›</button>
        </div>
      </div>
      <div class="shelf-scroll">${newest.map(shelfCardHtml).join('')}</div>
    </section>` : ''}

    ${best.length ? `
    <section class="shelf">
      <div class="shelf-head">
        <h2>Nejoblíbenější</h2>
        <div class="shelf-tools">
          <a href="#/vse">Zobrazit vše</a>
          <button class="shelf-btn" data-scroll="-1" aria-label="Posunout doleva">‹</button>
          <button class="shelf-btn" data-scroll="1" aria-label="Posunout doprava">›</button>
        </div>
      </div>
      <div class="shelf-scroll">${best.map(shelfCardHtml).join('')}</div>
    </section>` : ''}

    ${cats.length ? `
    <section class="shelf">
      <div class="shelf-head"><h2>Kategorie</h2><div class="shelf-tools"><a href="#/kategorie">Všechny</a></div></div>
      <div class="cat-mini">
        ${cats.map(c => `<a href="#/kategorie/${encodeURIComponent(c)}">${escapeHtml(c)}</a>`).join('')}
      </div>
    </section>` : ''}

    ${addRecipeCardHtml()}`;

  // šipky poliček (desktop) — posun o šířku viditelné části; bez přetečení se schovají
  view.querySelectorAll('.shelf-btn').forEach(b => b.addEventListener('click', () => {
    const sc = b.closest('.shelf').querySelector('.shelf-scroll');
    sc.scrollBy({ left: +b.dataset.scroll * (sc.clientWidth - 120), behavior: 'smooth' });
  }));
  view.querySelectorAll('.shelf-scroll').forEach(sc => {
    if (sc.scrollWidth <= sc.clientWidth) {
      sc.closest('.shelf').querySelectorAll('.shelf-btn').forEach(b => { b.style.display = 'none'; });
    }
  });
  wireViewAvatarButtons(); renderProfileButtons();
}

/* ================= Kategorie — dlaždice ================= */
function renderCatsPage() {
  const noneCount = catCount('none');
  view.innerHTML = `
    <div class="page-head">
      <div class="ph-text">
        <div class="page-title">Kategorie</div>
        <div class="page-sub">${state.recipes.length} receptů ve sbírce</div>
      </div>
    </div>
    <div class="tile-grid">
      <a class="cat-tile tile-all ${catGrad('__all')}" href="#/vse" style="${catColorStyle('__all')}">
        <span class="ct-name">Všechny recepty</span>
        <span class="ct-count">${state.recipes.length}</span>
      </a>
      ${state.categories.map(c => `
        <a class="cat-tile ${catGrad(c)}" href="#/kategorie/${encodeURIComponent(c)}" style="${catColorStyle(c)}">
          <span class="ct-glyph${isEmojiGlyph(catGlyph(c)) ? ' is-emoji' : ''}">${catGlyph(c)}</span>
          <span class="ct-name">${escapeHtml(c)}</span>
          <span class="ct-count">${catCount(c)}</span>
        </a>`).join('')}
      ${noneCount ? `
        <a class="cat-tile ${catGrad('__none')}" href="#/nezarazene" style="${catColorStyle('__none')}">
          <span class="ct-glyph">N</span>
          <span class="ct-name">Nezařazené</span>
          <span class="ct-count">${noneCount}</span>
        </a>` : ''}
    </div>
    ${guestMode ? '' : '<button class="ghost-btn" id="cats-manage">Upravit kategorie</button>'}`;
  view.querySelector('#cats-manage')?.addEventListener('click', openCategoryManager);
  renderProfileButtons();
}

/* ================= Výpis receptů ================= */
function renderListing(catKey) {
  const title = catKey === 'all' ? 'Všechny recepty' : catKey === 'none' ? 'Nezařazené' : catKey;
  const list = state.loaded ? listingRecipes(catKey) : null;

  view.innerHTML = `
  <div class="page-narrow">
    <div class="page-topbar">
      <button class="circle-btn" id="pg-back" aria-label="Zpět">${backSvg}</button>
      <span class="spacer"></span>
      <button class="circle-btn" id="pg-filter" aria-label="Filtry a řazení">
        ${filterSvg}
        ${filterCount() ? `<span class="badge-dot">${filterCount()}</span>` : ''}
      </button>
    </div>
    <div class="page-head">
      <div class="ph-text">
        <div class="page-title">${escapeHtml(title)}</div>
        <div class="page-sub">${list ? list.length + ' receptů' : 'Načítám…'}</div>
      </div>
    </div>
    ${activeFiltersHtml()}
    <div>
      ${!list
        ? `<div class="row-list">${'<div class="skel-row"><div class="sk-thumb"></div><div class="sk-lines"><div class="sk-line"></div><div class="sk-line short"></div></div></div>'.repeat(5)}</div>`
        : list.length
          ? `<div class="row-list">${list.map(r => rowHtml(r, { currentCat: catKey })).join('')}</div>`
          : `<div class="empty"><h3>Nic tu není</h3><p>${filterCount() ? 'Zkus povolit filtry.' : 'Zatím sem nikdo nic nepřidal.'}</p><a class="btn btn-primary" href="#/novy">Přidat recept</a></div>`}
    </div>
  </div>`;

  view.querySelector('#pg-back').addEventListener('click', () => goBack('#/kategorie'));
  view.querySelector('#pg-filter').addEventListener('click', e => openFilterSheet(e.currentTarget, () => renderListing(catKey)));
  bindActiveFilters(view, () => renderListing(catKey));
}

/* ================= Hledání ================= */
function renderSearchPage() {
  view.innerHTML = `
    <div class="page-narrow">
    <div class="page-topbar">
      <span class="spacer"></span>
      <button class="circle-btn" id="pg-filter" aria-label="Filtry a řazení">
        ${filterSvg}
        ${filterCount() ? `<span class="badge-dot">${filterCount()}</span>` : ''}
      </button>
    </div>
    <div class="page-head">
      <div class="ph-text">
        <div class="page-title">Hledat</div>
        <div class="page-sub">podle názvu, nebo podle toho, co máš doma</div>
      </div>
    </div>
      <div class="search-box">
        <input type="search" id="search-input" autocomplete="off"
          placeholder="${state.searchMode === 'ingredients' ? 'kuře, rýže, smetana…' : 'Hledat recept…'}"
          value="${escapeHtml(state.searchQuery)}">
        <button class="sb-clear" id="search-clear" ${state.searchQuery ? '' : 'hidden'}>✕</button>
      </div>
      <div class="chip-row scope-row" id="search-scope">
        <button class="fchip ${state.searchMode === 'name' ? 'active' : ''}" data-mode="name">Název</button>
        <button class="fchip ${state.searchMode === 'ingredients' ? 'active' : ''}" data-mode="ingredients">Ingredience</button>
      </div>
      <p class="search-hint" id="search-hint" ${state.searchMode === 'ingredients' ? '' : 'hidden'}>
        Zadej suroviny oddělené čárkou. Recepty se seřadí podle toho, kolik z nich obsahují.
      </p>
      <div id="af-wrap">${activeFiltersHtml()}</div>
      <div id="search-results"></div>
    </div>`;

  const input = view.querySelector('#search-input');
  const clearBtn = view.querySelector('#search-clear');

  // scope hledání jako v Mailu či Poznámkách: chipy pod vyhledávacím polem
  const scope = view.querySelector('#search-scope');
  scope.addEventListener('click', e => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.searchMode = btn.dataset.mode;
    scope.querySelectorAll('.fchip').forEach(b => b.classList.toggle('active', b === btn));
    input.placeholder = state.searchMode === 'ingredients' ? 'kuře, rýže, smetana…' : 'Hledat recept…';
    view.querySelector('#search-hint').hidden = state.searchMode !== 'ingredients';
    updateSearchResults();
    input.focus();
  });

  input.addEventListener('input', () => {
    state.searchQuery = input.value;
    clearBtn.hidden = !input.value;
    updateSearchResults();
  });
  clearBtn.addEventListener('click', () => {
    state.searchQuery = ''; input.value = ''; clearBtn.hidden = true;
    updateSearchResults(); input.focus();
  });
  view.querySelector('#pg-filter').addEventListener('click', e => openFilterSheet(e.currentTarget, () => {
    renderSearchFilterBits();
    updateSearchResults();
  }));

  function renderSearchFilterBits() {
    const fb = view.querySelector('#pg-filter');
    fb.innerHTML = `${filterSvg}${filterCount() ? `<span class="badge-dot">${filterCount()}</span>` : ''}`;
    const wrap = view.querySelector('#af-wrap');
    wrap.innerHTML = activeFiltersHtml();
    bindActiveFilters(wrap, () => { renderSearchFilterBits(); updateSearchResults(); });
  }
  bindActiveFilters(view.querySelector('#af-wrap'), () => { renderSearchFilterBits(); updateSearchResults(); });

  updateSearchResults();
  renderProfileButtons();
}

function updateSearchResults() {
  const box = view.querySelector('#search-results');
  if (!box) return;
  const results = searchResults();
  if (results === null) {
    box.innerHTML = `<div class="empty">
      <h3>${state.searchMode === 'ingredients' ? 'Co máš v lednici?' : 'Začni psát'}</h3>
      <p>${state.searchMode === 'ingredients' ? 'Vypiš suroviny a uvidíš, co z nich jde uvařit.' : 'Hledá se i bez diakritiky, „kureci" najde „Kuřecí".'}</p></div>
      ${addRecipeCardHtml()}`;
    return;
  }
  box.innerHTML = results.length
    ? `<div class="result-count" style="margin-bottom:10px">${results.length} výsledků</div>
       <div class="row-list">${results.map(r => rowHtml(r)).join('')}</div>`
    : `<div class="empty"><h3>Nic jsme nenašli</h3><p>Zkus jiné zadání${filterCount() ? ' nebo povol filtry' : ''}.</p></div>`;
}

/* ================= Filtry — zakotvený popover (stejný design jako „•••" menu) =============
   Design/princip převzatý z openContextMenu: zakotvený popover u tlačítka filtru,
   obyčejný průhledný blur, rozbalovací animace. Funkce (řazení/čas/autor) beze změny —
   živě přepočítává výpis vzadu (onChange), stejně jako dřív. */
function openFilterSheet(anchorEl, onChange) {
  const SORT_LABELS = { newest: 'Nejnovější', alpha: 'Abecedně', best: 'Nejoblíbenější' };
  const TIME_LABELS = { 'all': 'Vše', '30': 'Do 30 min', '60': 'Do 1 hodiny', '120': 'Do 2 hodin', '120+': 'Přes 2 hodiny' };
  const authors = [...new Set([...state.profiles, ...state.recipes.map(r => r.author).filter(Boolean)])];

  const html = `
    <div class="ctx-filter">
      <div class="filter-section">
        <h4>Řazení</h4>
        <div class="chip-row">
          ${Object.entries(SORT_LABELS).map(([k, l]) =>
            `<button class="fchip ${state.sortMode === k ? 'active' : ''}" data-sort="${k}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="filter-section">
        <h4>Doba přípravy</h4>
        <div class="chip-row">
          ${Object.entries(TIME_LABELS).map(([k, l]) =>
            `<button class="fchip ${state.timeFilter === k ? 'active' : ''}" data-time="${k}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="filter-section">
        <h4>Autor</h4>
        <div class="chip-row">
          ${authors.length ? authors.map(a =>
            `<button class="fchip ${state.profileFilter.includes(a) ? 'active' : ''}" data-author="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('')
            : '<p class="muted" style="margin:0;font-size:14px">Zatím žádní autoři</p>'}
        </div>
      </div>
      <button class="btn btn-block" id="filter-reset">Zrušit filtry a řazení</button>
    </div>`;
  const po = openPopover(anchorEl, html, { className: 'ctx-menu-filter' });

  po.panel.addEventListener('click', e => {
    const s = e.target.closest('[data-sort]');
    const t = e.target.closest('[data-time]');
    const a = e.target.closest('[data-author]');
    if (s) {
      state.sortMode = s.dataset.sort;
      po.panel.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b === s));
    } else if (t) {
      state.timeFilter = t.dataset.time;
      po.panel.querySelectorAll('[data-time]').forEach(b => b.classList.toggle('active', b === t));
    } else if (a) {
      const name = a.dataset.author;
      if (state.profileFilter.includes(name)) state.profileFilter = state.profileFilter.filter(p => p !== name);
      else state.profileFilter.push(name);
      a.classList.toggle('active');
    } else if (e.target.id === 'filter-reset') {
      state.profileFilter = []; state.timeFilter = 'all'; state.sortMode = 'newest';
      onChange();
      po.close();
      return;
    } else return;
    onChange();
  });
}

/* ================= Detail receptu ================= */
function getRecipe(id) { return state.recipes.find(r => r.id === id); }

function stepsKey(id) { return 'kucharka-steps-' + id; }
function getCheckedSteps(id) {
  try { return new Set(JSON.parse(localStorage.getItem(stepsKey(id)) || '[]')); }
  catch { return new Set(); }
}
function setCheckedSteps(id, set) {
  if (set.size) localStorage.setItem(stepsKey(id), JSON.stringify([...set]));
  else localStorage.removeItem(stepsKey(id));
}

let detailId = null;
let detailPortions = 1;

function renderDetailPage(id) {
  if (!state.loaded) {
    view.innerHTML = `<div class="page-narrow"><div class="skel-hero"></div>
      <div class="row-list">${'<div class="skel-row"><div class="sk-thumb"></div><div class="sk-lines"><div class="sk-line"></div><div class="sk-line short"></div></div></div>'.repeat(3)}</div></div>`;
    return;
  }
  const r = getRecipe(id);
  if (!r) {
    view.innerHTML = `<div class="empty"><h3>Recept nenalezen</h3><p>Možná ho někdo právě smazal.</p><a class="btn btn-primary" href="#/">Zpět domů</a></div>`;
    return;
  }
  if (detailId !== id) {
    detailId = id;
    detailPortions = parseInt(r.portions) || 1;
  }

  const basePortions = parseInt(r.portions) || 1;
  const currentMult = () => detailPortions / basePortions;
  const mult = currentMult();   // pro první vykreslení
  const ings = (r.ingredients || []).filter(i => i.name);
  const steps = (r.steps || []).filter(Boolean);
  const reviews = r.reviews || [];
  const avg = avgRating(reviews);
  const checked = getCheckedSteps(id);

  view.innerHTML = `
  <div class="detail-wrap">
    <div class="detail-hero">
      ${r.photo
        ? `<img src="${escapeHtml(r.photo)}" alt="">`
        : `<div class="dh-ph ${catGrad(primaryCategory(r) || '__none')}${isEmojiGlyph(recipeGlyph(r)) ? ' is-emoji' : ''}" style="${catColorStyle(primaryCategory(r) || '__none')}">${recipeGlyph(r)}</div>`}
      <div class="dh-top"></div>
      <button class="dh-back" id="d-back" aria-label="Zpět">${backSvg}</button>
      <div class="dh-actions">
        ${readOnly() ? '' : `<button class="dh-btn" id="d-share" aria-label="${r.shared ? 'Sdíleno' : 'Sdílet'}">${shareSvg}</button>`}
        <button class="dh-btn" id="d-more" aria-label="Další akce">${dotsSvg}</button>
      </div>
    </div>

    <div class="detail-card">
      ${recipeCategories(r).length ? `<div class="detail-kicker">${recipeCategories(r).map(escapeHtml).join(' · ')}</div>` : ''}
      <h1 class="detail-title">${escapeHtml(r.name)}</h1>
      <div class="meta-pills">
        ${r.cookTime ? `<span class="mpill">${formatTime(r.cookTime)}</span>` : ''}
        ${r.portions ? `<span class="mpill">${escapeHtml(String(r.portions))} porcí</span>` : ''}
        ${r.author ? `<span class="mpill">${escapeHtml(r.author)}</span>` : ''}
        ${avg ? `<span class="mpill"><span class="st">★</span> ${fmtAvg(avg)} (${reviews.length})</span>` : ''}
      </div>
    </div>

    <div class="detail-cols ${ings.length && steps.length ? 'two' : ''}">
      ${ings.length ? `
      <div class="dsection detail-col-ing">
        <div class="dsection-head"><h3>Ingredience</h3></div>
        <div class="portion-bar">
          <div><b>Porce</b><small>původně na ${basePortions}</small></div>
          <div class="stepper">
            <button id="port-minus" aria-label="Méně porcí">−</button>
            <span class="stepper-val" id="port-val">${detailPortions}</span>
            <button id="port-plus" aria-label="Více porcí">+</button>
          </div>
        </div>
        <ul class="ing-list">
          ${ings.map(i => `
            <li>
              <span class="ing-qty">${escapeHtml([scaleQty(i.qty, mult), i.unit && i.unit !== '—' ? i.unit : ''].filter(Boolean).join(' ')) || '&nbsp;'}</span>
              <span>${escapeHtml(i.name)}</span>
            </li>`).join('')}
        </ul>
        <button class="btn btn-primary btn-block ing-shop-btn" id="act-shop">${cartSvg} Do nákupního seznamu</button>
      </div>` : ''}

      ${steps.length ? `
      <div class="dsection">
        <div class="dsection-head">
          <h3>Postup</h3>
          ${checked.size ? `<button class="link-btn" id="steps-reset">Vynulovat (${checked.size})</button>` : ''}
        </div>
        <div class="step-list">
          ${steps.map((s, i) => `
            <button class="step-item ${checked.has(i) ? 'done' : ''}" data-step="${i}">
              <span class="step-num">${checked.has(i) ? '✓' : i + 1}</span>
              <span class="step-text">${escapeHtml(s)}</span>
            </button>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <div class="dsection">
      <div class="dsection-head"><h3>Hodnocení</h3></div>
      ${reviews.length ? `
        <div class="review-avg">
          <span class="big-num">${fmtAvg(avg)}</span>
          <div><div class="stars">${starsText(avg)}</div><small>${reviews.length}× hodnoceno</small></div>
        </div>` : '<p class="muted" style="font-size:14px;margin:0 0 10px">Zatím bez hodnocení. Buď první!</p>'}
      ${reviews.map(rv => `
        <div class="review-item">
          <div class="review-head">
            ${personAvatarHtml(rv.author)}
            <span class="review-author">${escapeHtml(rv.author)}</span>
            <span class="stars" style="font-size:13px">${starsText(rv.stars)}</span>
            <span class="review-date">${formatDate(rv.createdAt)}</span>
            ${(!readOnly() && isMine(rv)) ? `<button class="review-del" data-del-review="${escapeHtml(rv.id)}" aria-label="Smazat recenzi">${trashSvg}</button>` : ''}
          </div>
          ${rv.comment ? `<p class="review-comment">${escapeHtml(rv.comment)}</p>` : ''}
        </div>`).join('')}
      ${readOnly() ? '' : `<button class="btn btn-primary btn-block" id="act-review" style="margin-top:10px">Přidat hodnocení</button>`}
    </div>

    <p class="detail-footnote">
      Přidáno ${formatDate(r.createdAt)}${r.updatedAt ? ` · upraveno ${formatDate(r.updatedAt)}` : ''}
    </p>
  </div>`;

  view.querySelector('#d-back').addEventListener('click', () => goBack('#/'));

  /* Porce mění jen čísla u ingrediencí — překreslovat kvůli tomu celou stránku
     znamenalo zahodit i <img> s fotkou, která pak musela znovu naskočit (blikala).
     Proto se sahá přímo na dotčené prvky. */
  const portVal = view.querySelector('#port-val');
  const qtyCells = [...view.querySelectorAll('.ing-list .ing-qty')];
  function refreshPortions() {
    const m = currentMult();
    if (portVal) portVal.textContent = detailPortions;
    qtyCells.forEach((cell, idx) => {
      const i = ings[idx];
      if (!i) return;
      const txt = [scaleQty(i.qty, m), i.unit && i.unit !== '—' ? i.unit : ''].filter(Boolean).join(' ');
      cell.textContent = txt || '\u00a0';
    });
  }
  view.querySelector('#port-minus')?.addEventListener('click', () => {
    if (detailPortions > 1) { detailPortions--; refreshPortions(); }
  });
  view.querySelector('#port-plus')?.addEventListener('click', () => {
    if (detailPortions < 99) { detailPortions++; refreshPortions(); }
  });

  // Odškrtnutí kroku taky nesmí překreslit stránku (viz fotka výše).
  const stepsHead = view.querySelector('.dsection-head');
  function refreshStepsReset(count) {
    let btn = view.querySelector('#steps-reset');
    if (count > 0 && !btn && stepsHead) {
      stepsHead.insertAdjacentHTML('beforeend', '<button class="link-btn" id="steps-reset">Vynulovat (' + count + ')</button>');
      wireStepsReset();
    } else if (count > 0 && btn) {
      btn.textContent = 'Vynulovat (' + count + ')';
    } else if (btn) {
      btn.remove();
    }
  }
  function wireStepsReset() {
    view.querySelector('#steps-reset')?.addEventListener('click', () => {
      setCheckedSteps(id, new Set());
      view.querySelectorAll('[data-step]').forEach(b => {
        b.classList.remove('done');
        b.querySelector('.step-num').textContent = +b.dataset.step + 1;
      });
      refreshStepsReset(0);
    });
  }
  wireStepsReset();

  view.querySelectorAll('[data-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.step;
      const set = getCheckedSteps(id);
      const done = set.has(i);
      done ? set.delete(i) : set.add(i);
      setCheckedSteps(id, set);
      btn.classList.toggle('done', !done);
      btn.querySelector('.step-num').textContent = !done ? '✓' : i + 1;
      refreshStepsReset(set.size);
    });
  });

  view.querySelector('#act-shop')?.addEventListener('click', () => {
    const n = addRecipeToShopping(r, currentMult());
    if (!n) { toast('Recept nemá ingredience'); return; }
    toast(`Přidáno ${n} položek do nákupního seznamu`);
  });
  view.querySelector('#d-more').addEventListener('click', e => openRecipeActions(e.currentTarget, r, currentMult(), detailPortions));
  view.querySelector('#d-share')?.addEventListener('click', () => openShareSheet(r));

  view.querySelector('#act-review')?.addEventListener('click', () => openReviewForm(r));
  view.querySelectorAll('[data-del-review]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog('Smazat recenzi?', 'Recenze bude odstraněna.', { okLabel: 'Smazat', danger: true });
      if (!ok) return;
      const fresh = getRecipe(id);
      if (!fresh) return;
      await saveRecipe({ ...fresh, reviews: (fresh.reviews || []).filter(rv => rv.id !== btn.dataset.delReview) });
    });
  });
}

/* Menu správcovských akcí receptu (vzor iOS „•••" More): kompaktní vycentrovaný
   panel se seznamem akcí (ikona + popisek), destruktivní „Smazat" oddělené a červené
   dole. Hlavní akce (Do nákupního seznamu) tady NENÍ — ta je viditelná u ingrediencí. */
// Obecný ZAKOTVENÝ popover u tlačítka (vzor Apple Podcasts) — sdílený základ pro
// „•••" menu i filtr. Vloží panel s obyčejným průhledným blurem, umístí ho pod
// kotvu (pravým okrajem k jejímu pravému okraji; nahoru, když se dolů nevejde) a
// rozbalí ho animací (scale-in z rohu u kotvy). Vrací { bd, panel, close }.
function openPopover(anchorEl, innerHtml, { className = '' } = {}) {
  const root = document.getElementById('modal-root');
  const bd = document.createElement('div');
  bd.className = 'menu-backdrop';
  bd.innerHTML = `<div class="ctx-menu ${className}" role="menu">${innerHtml}</div>`;
  root.appendChild(bd);
  const panel = bd.querySelector('.ctx-menu');

  const a = anchorEl.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = panel.offsetWidth, mh = panel.offsetHeight;
  const right = Math.min(Math.max(10, vw - a.right), Math.max(10, vw - mw - 10));
  let topPos = a.bottom + 8;
  const flipUp = topPos + mh > vh - 10;
  if (flipUp) topPos = Math.max(10, a.top - mh - 8);
  panel.style.right = right + 'px';
  panel.style.top = topPos + 'px';
  panel.style.transformOrigin = flipUp ? 'bottom right' : 'top right';   // roste z rohu u kotvy

  let closed = false;
  const close = () => { if (closed) return; closed = true; bd.classList.add('closing'); setTimeout(() => bd.remove(), 180); };
  bd.addEventListener('click', e => { if (e.target === bd) close(); });
  // dvojité rAF: nejdřív se vykreslí výchozí stav (scale .82), pak se spustí přechod
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('in')));
  return { bd, panel, close };
}

/* ===== Nezhasínat displej (Wake Lock) — ať mobil při vaření podle receptu nezhasne
   a nezamkne se. Uživatelský záměr (wakeLockOn) drží, dokud ho sám nevypne; prohlížeč
   zámek uvolní, když appka není vidět (přepnutí/zamčení) — po návratu ho zas vezmeme. */
let wakeLockSentinel = null;
let wakeLockOn = false;
const wakeLockSupported = 'wakeLock' in navigator;
async function acquireWakeLock() {
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
    return true;
  } catch { return false; }
}
async function setWakeLock(on) {
  wakeLockOn = on;
  if (on) {
    if (await acquireWakeLock()) { toast('Displej zůstane rozsvícený'); return true; }
    wakeLockOn = false;
    toast('Rozsvícený displej tenhle prohlížeč neumí udržet');
    return false;
  }
  if (wakeLockSentinel) { try { await wakeLockSentinel.release(); } catch { /* už uvolněný */ } }
  wakeLockSentinel = null;
  toast('Displej se zase může zhasínat');
  return false;
}
document.addEventListener('visibilitychange', () => {
  if (wakeLockOn && document.visibilityState === 'visible' && !wakeLockSentinel) acquireWakeLock();
});

// „•••" menu: `top` = rychlé akce nahoře (ikona nad popiskem, v řadě), `list` =
// akce pod nimi (ikona vlevo). Položka: { icon, label, onClick } nebo { href };
// `checked:true` = přepínač v zapnutém stavu (fajfka vpravo, jako iOS UIMenu).
function openContextMenu(anchorEl, { top = [], list = [] }) {
  const checkMark = `<svg class="ctx-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const itemHtml = (it, cls) => {
    const inner = `${it.icon}<span>${escapeHtml(it.label)}</span>${it.tag ? `<span class="ctx-tag">${escapeHtml(it.tag)}</span>` : ''}${it.checked ? checkMark : ''}`;
    const c = cls + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '');
    return it.href ? `<a class="${c}" href="${it.href}">${inner}</a>` : `<button type="button" class="${c}">${inner}</button>`;
  };
  const html = `
    ${top.length ? `<div class="ctx-top">${top.map(it => itemHtml(it, 'ctx-top-item')).join('')}</div>` : ''}
    ${list.length ? `<div class="ctx-list">${list.map(it => itemHtml(it, 'ctx-item')).join('')}</div>` : ''}`;
  const po = openPopover(anchorEl, html);
  const all = [...top, ...list];
  po.panel.addEventListener('click', e => {
    const btn = e.target.closest('.ctx-top-item,.ctx-item');
    if (!btn) return;
    const idx = [...po.panel.querySelectorAll('.ctx-top-item,.ctx-item')].indexOf(btn);
    po.close();
    if (btn.tagName !== 'A') all[idx]?.onClick?.();   // odkaz naviguje sám
  });
  return po;
}

// Menu správcovských akcí receptu. Hlavní akce (Do nákupního seznamu) tady NENÍ —
// ta je viditelná u ingrediencí. Upravit/Smazat jen autor (canEditRecipe).
function openRecipeActions(anchorEl, r, mult, portions) {
  const ro = readOnly();
  const mine = canEditRecipe(r);
  const copyAi = async () => {
    try { await navigator.clipboard.writeText(aiPromptText(r, mult, portions)); toast('Zkopírováno. Vlož text do svého AI asistenta.'); }
    catch { alertDialog('Kopírování se nepovedlo', 'Prohlížeč nedovolil přístup ke schránce.'); }
  };
  const del = async () => {
    const ok = await confirmDialog('Smazat recept?', `„${r.name}" zmizí všem a nejde to vrátit.`, { okLabel: 'Smazat', danger: true });
    if (ok && await deleteRecipe(r.id)) { setCheckedSteps(r.id, new Set()); location.hash = '#/'; toast('Recept smazán'); }
  };
  const top = [];
  if (mine) top.push({ icon: editSvg, label: 'Upravit', href: '#/upravit/' + encodeURIComponent(r.id) });
  if (!ro) top.push({ icon: shareSvg, label: r.shared ? 'Sdíleno' : 'Sdílet', onClick: () => openShareSheet(r) });
  const list = [];
  if (wakeLockSupported)
    list.push({ icon: sunSvg, label: 'Nezhasínat displej', checked: wakeLockOn, onClick: () => setWakeLock(!wakeLockOn) });
  list.push({ icon: aiSvg, label: 'Kopírovat pro AI', onClick: copyAi });
  if (mine) list.push({ icon: trashSvg, label: 'Smazat recept', danger: true, onClick: del });
  openContextMenu(anchorEl, { top, list });
}

/* ================= Nákupní seznam (stránka) ================= */
const bagSvg = `<svg viewBox="0 0 24 24" width="46" height="46"><path d="M7 8V6.5a5 5 0 0 1 10 0V8m-13 0h16l-1 12.2a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 20.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function renderShoppingPage() {
  view.innerHTML = `
  <div class="page-narrow">
    <div class="page-topbar">
      <span class="spacer"></span>
      <button class="circle-btn" id="shop-filter" aria-label="Řazení a možnosti" hidden>${filterSvg}</button>
    </div>
    <div class="page-head">
      <div class="ph-text">
        <div class="page-title">Nákupní seznam</div>
        <div class="page-sub"></div>
      </div>
    </div>

    <form class="shop-add" id="shop-add-form">
      <input class="shop-add-input" id="shop-add-input" placeholder="Přidat položku…" autocomplete="off" enterkeyhint="done">
      <button type="submit" class="shop-add-btn" aria-label="Přidat">${plusSvg}</button>
    </form>

    <div id="shop-body"></div>
  </div>`;

  renderProfileButtons();

  const form = view.querySelector('#shop-add-form');
  const input = view.querySelector('#shop-add-input');

  /* Klepnutí na „+" by poli sebralo zaostření a klávesnice by sjela dolů. iOS ji
     přitom z kódu (input.focus()) znovu neotevře — musí to být přímá reakce na
     dotek uživatele. Zabráníme proto samotné změně zaostření: `preventDefault`
     na mousedown/pointerdown zruší přesun fokusu, ale odeslání formuláře nechá
     proběhnout. Díky tomu jde psát položky jednu za druhou bez naklikávání. */
  const addBtn = form.querySelector('.shop-add-btn');
  ['mousedown', 'pointerdown'].forEach(ev =>
    addBtn.addEventListener(ev, e => { if (document.activeElement === input) e.preventDefault(); }));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const val = input.value.trim();
    if (!val) return;
    addShoppingItem(val);
    input.value = '';
    input.focus();
    renderShoppingBody();
    updateShopHead();
  });

  view.querySelector('#shop-filter').addEventListener('click', openShoppingOptions);

  renderShoppingBody();
  updateShopHead();
}

function updateShopHead() {
  const active = state.shopping.filter(i => !i.done).length;
  const done = state.shopping.filter(i => i.done).length;
  const sub = view.querySelector('.page-sub');
  if (sub) sub.textContent = `${active ? active + ' k nákupu' : (done ? 'vše koupeno' : 'zatím prázdné')}${done ? ' · ' + done + ' koupeno' : ''}`;
  const filterBtn = view.querySelector('#shop-filter');
  if (filterBtn) filterBtn.hidden = !state.shopping.length;
}

// Vykreslí tělo seznamu. Odškrtnuté položky NEmizí dolů — zůstanou přeškrtnuté
// na svém místě. Drží se odděleně od hlavičky, ať input nepřebliká.
function renderShoppingBody() {
  const body = view.querySelector('#shop-body');
  if (!body) return;
  const items = state.shopping;

  if (!items.length) {
    body.innerHTML = `
      <div class="empty shop-empty">
        <div class="shop-empty-icon">${bagSvg}</div>
        <h3>Seznam je prázdný</h3>
        <p>Napiš si sem, co potřebuješ, nebo přidej ingredience z receptu tlačítkem „Do nákupního seznamu".</p>
      </div>`;
    return;
  }

  let html = '';
  if (state.shoppingSort === 'store') {
    for (const cat of STORE_CATEGORIES) {
      const group = items.filter(i => (i.cat || 'ostatni') === cat.key);
      if (!group.length) continue;
      html += `
        <div class="shop-section" data-cat="${escapeHtml(cat.key)}">
          <div class="shop-section-head">${escapeHtml(cat.label)}</div>
          <div class="settings-card shop-list" data-cat="${escapeHtml(cat.key)}">${group.map(shopRowHtml).join('')}</div>
        </div>`;
    }
  } else {
    html += `<div class="shop-section" data-cat="__added"><div class="settings-card shop-list" data-cat="__added">${items.map(shopRowHtml).join('')}</div></div>`;
  }

  body.innerHTML = html;
  wireShoppingItems(body);
}

function shopRowHtml(it) {
  return `
    <div class="shop-row ${it.done ? 'done' : ''}" data-id="${escapeHtml(it.id)}">
      <button class="shop-swipe-delete" type="button" tabindex="-1">Smazat</button>
      <div class="shop-content">
        <button class="shop-check" aria-label="${it.done ? 'Vrátit' : 'Koupeno'}">
          <span class="shop-check-dot">${it.done ? checkSvg : ''}</span>
        </button>
        <span class="shop-text">${escapeHtml(it.text)}</span>
        <button class="shop-handle drag-handle" aria-label="Přesunout">${dragSvg}</button>
      </div>
    </div>`;
}

function wireShoppingItems(root) {
  // odškrtnutí zůstává na místě (žádné překreslení, jen přepnutí stavu řádku)
  root.querySelectorAll('.shop-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('.shop-check').addEventListener('click', () => {
      if (row._swiped) { row._swiped = false; return; }
      const it = state.shopping.find(x => x.id === id);
      if (!it) return;
      it.done = !it.done;
      saveShopping();
      row.classList.toggle('done', it.done);
      row.querySelector('.shop-check-dot').innerHTML = it.done ? checkSvg : '';
      row.querySelector('.shop-check').setAttribute('aria-label', it.done ? 'Vrátit' : 'Koupeno');
      updateShopHead();
    });
  });

  function deleteItem(id) {
    state.shopping = state.shopping.filter(x => x.id !== id);
    saveShopping();
    renderShoppingBody();
    updateShopHead();
  }

  const lists = [...root.querySelectorAll('.shop-list')];
  lists.forEach(listEl => {
    enableShopSwipe(listEl, deleteItem);
    enableShopDrag(listEl, lists, root);
  });
}

function closeShopSwipes(root, except) {
  root.querySelectorAll('.shop-row.open').forEach(r => {
    if (r === except) return;
    if (r._swipeReset) r._swipeReset();
  });
}

// Swipe zprava doleva odhalí zaoblené „Smazat" (narůstá s tahem, full-swipe maže) —
// stejný vzor jako správa kategorií.
function enableShopSwipe(listEl, deleteItem) {
  const BTN = 88, RIGHT = 12, GAP = 8, OPENX = BTN + RIGHT + GAP, OPEN_TRIGGER = 46;
  const root = listEl.closest('#shop-body') || listEl;
  listEl.querySelectorAll('.shop-content').forEach(content => {
    const row = content.closest('.shop-row');
    const delBtn = row.querySelector('.shop-swipe-delete');
    let s = null;
    function apply(x) { content.style.transform = `translateX(${x}px)`; delBtn.style.width = Math.max(BTN, -x - RIGHT - GAP) + 'px'; }
    function reset() { content.style.transform = ''; delBtn.style.width = ''; row.classList.remove('open'); }
    row._swipeReset = reset;

    content.addEventListener('pointerdown', e => {
      if (e.target.closest('.shop-handle') || e.target.closest('.shop-check')) return;
      s = { x0: e.clientX, y0: e.clientY, base: row.classList.contains('open') ? -OPENX : 0, decided: false, horiz: false, dx: 0, w: content.offsetWidth };
    });
    content.addEventListener('pointermove', e => {
      if (!s) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        s.decided = true;
        s.horiz = Math.abs(dx) > Math.abs(dy);
        if (s.horiz) { row.classList.add('swiping'); closeShopSwipes(root, row); try { content.setPointerCapture(e.pointerId); } catch { /* syntetické */ } }
        else { s = null; return; }
      }
      e.preventDefault();
      const x = Math.max(-(s.w - RIGHT), Math.min(0, s.base + dx));
      s.dx = x; apply(x);
    });
    const finish = () => {
      if (!s) return;
      const st = s; s = null;
      row.classList.remove('swiping');
      if (!st.horiz) return;
      row._swiped = true;
      if (-st.dx >= st.w * 0.5) { deleteItem(row.dataset.id); return; }
      if (-st.dx >= OPEN_TRIGGER) { apply(-OPENX); row.classList.add('open'); }
      else reset();
    };
    content.addEventListener('pointerup', finish);
    content.addEventListener('pointercancel', finish);
    content.addEventListener('click', e => {
      if (row._swiped) { row._swiped = false; return; }
      if (e.target.closest('.shop-handle') || e.target.closest('.shop-check')) return;
      if (row.classList.contains('open')) reset(); else closeShopSwipes(root);
    });
    delBtn.addEventListener('click', () => deleteItem(row.dataset.id));
  });
}

// Tažení za úchyt — STEJNÁ plynulá mechanika jako přeskládání kategorií:
// tažený řádek jede za prstem, ostatní řádky v sekci uhýbají, DOM se přeskládá až po
// puštění. Když prst zajede do JINÉ sekce (režim „Podle kategorií"), sekce se zvýrazní
// a puštění položku přeřadí do té kategorie.
function enableShopDrag(listEl, allLists, root) {
  let drag = null;
  listEl.querySelectorAll('.shop-handle').forEach(handle => {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      closeShopSwipes(root);
      const row = handle.closest('.shop-row');
      const rows = [...listEl.querySelectorAll('.shop-row')];
      // svislé pásy ostatních sekcí (pro přeřazení tažením mezi kategoriemi)
      const others = allLists.filter(l => l !== listEl).map(l => {
        const sec = l.closest('.shop-section');
        const r = sec.getBoundingClientRect();
        return { cat: l.dataset.cat, top: r.top, bottom: r.bottom, sec };
      });
      drag = {
        row, rows, others,
        startIndex: rows.indexOf(row), curIndex: rows.indexOf(row),
        startY: e.clientY, rowH: row.offsetHeight,
        dropCat: null, dropSec: null,
      };
      row.classList.add('dragging');
      rows.forEach(r => { if (r !== row) r.style.transition = 'transform .18s ease'; });
      try { handle.setPointerCapture(e.pointerId); } catch { /* syntetické */ }
    });

    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.startY;
      drag.row.style.transform = `translateY(${dy}px)`;

      // zajel prst do jiné sekce? -> mířím na přeřazení, ne na řazení v sekci
      const over = drag.others.find(o => e.clientY >= o.top && e.clientY <= o.bottom);
      if (over) {
        if (drag.dropCat !== over.cat) {
          if (drag.dropSec) drag.dropSec.classList.remove('drop-target');
          drag.dropCat = over.cat; drag.dropSec = over.sec;
          over.sec.classList.add('drop-target');
          drag.rows.forEach(r => { if (r !== drag.row) r.style.transform = ''; });
          drag.curIndex = drag.startIndex;
        }
        return;
      }
      if (drag.dropCat) {
        if (drag.dropSec) drag.dropSec.classList.remove('drop-target');
        drag.dropCat = null; drag.dropSec = null;
      }

      // řazení v rámci sekce: sousedé uhýbají
      const target = Math.max(0, Math.min(drag.rows.length - 1, drag.startIndex + Math.round(dy / drag.rowH)));
      if (target === drag.curIndex) return;
      drag.curIndex = target;
      drag.rows.forEach((r, i) => {
        if (r === drag.row) return;
        let shift = 0;
        if (drag.startIndex < target && i > drag.startIndex && i <= target) shift = -drag.rowH;
        else if (drag.startIndex > target && i >= target && i < drag.startIndex) shift = drag.rowH;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    });

    const finish = () => {
      if (!drag) return;
      const d = drag; drag = null;
      d.rows.forEach(r => { r.style.transition = ''; r.style.transform = ''; });
      d.row.classList.remove('dragging');
      if (d.dropSec) d.dropSec.classList.remove('drop-target');

      if (d.dropCat) {
        const id = d.row.dataset.id;
        const it = state.shopping.find(x => x.id === id);
        if (it && (it.cat || 'ostatni') !== d.dropCat) {
          it.cat = d.dropCat;
          state.shopping = state.shopping.filter(x => x.id !== id).concat(it);
          saveShopping();
          renderShoppingBody();
        }
      } else if (d.curIndex !== d.startIndex) {
        const order = d.rows.map(r => r.dataset.id);
        const [moved] = order.splice(d.startIndex, 1);
        order.splice(d.curIndex, 0, moved);
        if (listEl.dataset.cat === '__added') {
          state.shopping.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        } else {
          reorderCategoryItems(listEl.dataset.cat, order);
        }
        saveShopping();
        renderShoppingBody();
      }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
}

// Přeskládá pořadí položek jedné kategorie podle nového pořadí id, ostatní nechá být.
function reorderCategoryItems(catKey, idOrder) {
  const pos = new Map(idOrder.map((id, i) => [id, i]));
  const catItems = state.shopping
    .filter(it => (it.cat || 'ostatni') === catKey)
    .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  let k = 0;
  state.shopping = state.shopping.map(it => (it.cat || 'ostatni') === catKey ? catItems[k++] : it);
}

function openShoppingOptions() {
  const doneCount = state.shopping.filter(i => i.done).length;
  const sheet = openSheet({
    title: 'Nákupní seznam',
    bodyHtml: `
      <div class="form-label" style="margin-bottom:8px">Seřadit</div>
      <div class="settings-card" style="margin-bottom:20px">
        <button class="settings-row" data-sort="store">
          <span class="row-label">Podle kategorií</span>${state.shoppingSort === 'store' ? checkAccentSvg : ''}
        </button>
        <button class="settings-row" data-sort="added">
          <span class="row-label">V pořadí přidání</span>${state.shoppingSort === 'added' ? checkAccentSvg : ''}
        </button>
      </div>
      <button class="btn btn-block" id="so-share" style="margin-bottom:10px">Sdílet / kopírovat seznam</button>
      ${doneCount ? `<button class="btn btn-block" id="so-clear-done" style="margin-bottom:10px">Vymazat odškrtnuté (${doneCount})</button>` : ''}
      <button class="btn btn-block btn-danger" id="so-clear">Vymazat celý seznam</button>`,
  });
  sheet.body.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    state.shoppingSort = b.dataset.sort;
    localStorage.setItem('kucharka-shopping-sort', state.shoppingSort);
    sheet.close();
    renderShoppingBody();
  }));
  sheet.body.querySelector('#so-share').addEventListener('click', async () => {
    const text = shoppingListPlainText();
    if (!text) { toast('Seznam je prázdný'); return; }
    if (navigator.share) { navigator.share({ title: 'Nákupní seznam', text }).catch(() => {}); sheet.close(); return; }
    try { await navigator.clipboard.writeText(text); toast('Seznam zkopírován'); sheet.close(); }
    catch { alertDialog('Kopírování se nepovedlo', 'Prohlížeč nedovolil přístup ke schránce.'); }
  });
  sheet.body.querySelector('#so-clear-done')?.addEventListener('click', async () => {
    sheet.close();
    const ok = await confirmDialog('Vymazat odškrtnuté?', 'Koupené položky se ze seznamu odstraní.', { okLabel: 'Vymazat', danger: true });
    if (!ok) return;
    state.shopping = state.shopping.filter(x => !x.done);
    saveShopping();
    renderShoppingBody();
    updateShopHead();
  });
  sheet.body.querySelector('#so-clear').addEventListener('click', async () => {
    sheet.close();
    const ok = await confirmDialog('Vymazat celý seznam?', 'Všechny položky se odstraní. Nejde to vrátit.', { okLabel: 'Vymazat', danger: true });
    if (!ok) return;
    state.shopping = [];
    saveShopping();
    renderShoppingBody();
    updateShopHead();
  });
}

// Textová podoba seznamu ke sdílení/kopírování (seskupeno podle obchodu).
function shoppingListPlainText() {
  const items = state.shopping.filter(i => !i.done);
  if (!items.length) return '';
  const lines = ['Nákupní seznam', ''];
  for (const cat of STORE_CATEGORIES) {
    const group = items.filter(i => (i.cat || 'ostatni') === cat.key);
    if (!group.length) continue;
    lines.push(cat.label.toUpperCase());
    group.forEach(i => lines.push('• ' + i.text));
    lines.push('');
  }
  return lines.join('\n').trim();
}

/* ================= Sdílení receptu bez přihlášení ================= */
function shareUrl(r) {
  return location.origin + location.pathname + '#/recept/' + encodeURIComponent(r.id);
}
function openShareSheet(r) {
  const canShare = !!navigator.share;
  const body = shared => `
    <p class="muted" style="font-size:13px;margin:0 0 14px">Kdokoli s odkazem uvidí tento recept i bez přihlášení do kuchařky. Zbytek kuchařky zůstane zamčený.</p>
    <button class="btn btn-block ${shared ? '' : 'btn-primary'}" id="share-toggle">${shared ? 'Vypnout sdílení' : 'Zapnout sdílení'}</button>
    ${shared ? `
    <div class="form-row" style="margin-top:10px">
      ${canShare ? '<button class="btn btn-primary" id="share-native">Sdílet odkaz</button>' : ''}
      <button class="btn ${canShare ? '' : 'btn-primary'}" id="share-copy">Kopírovat odkaz</button>
    </div>` : ''}`;
  const sheet = openSheet({ title: 'Sdílet recept', bodyHtml: body(!!r.shared) });
  function wire(shared) {
    sheet.body.querySelector('#share-toggle').addEventListener('click', async () => {
      const fresh = getRecipe(r.id);
      if (!fresh) return;
      const next = !shared;
      if (!await saveRecipe({ ...fresh, shared: next })) return;
      sheet.body.innerHTML = body(next);
      wire(next);
      toast(next ? 'Recept jde teď otevřít bez přihlášení' : 'Sdílení vypnuto');
    });
    sheet.body.querySelector('#share-native')?.addEventListener('click', () => {
      navigator.share({ title: r.name, url: shareUrl(r) }).catch(() => {});
    });
    sheet.body.querySelector('#share-copy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(shareUrl(r)); toast('Odkaz zkopírován'); }
      catch { alertDialog('Kopírování se nepovedlo', 'Prohlížeč nedovolil přístup ke schránce.'); }
    });
  }
  wire(!!r.shared);
}

/* ================= Hodnocení ================= */
function openReviewForm(r) {
  const author = myName();
  const sheet = openSheet({
    title: 'Ohodnotit recept',
    bodyHtml: `
      <div class="form-group">
        <label class="form-label">Kdo hodnotí</label>
        <p style="margin:0 0 4px;font-weight:650">${escapeHtml(author)}</p>
      </div>
      <div class="form-group"><div id="rev-stars"></div></div>
      <div class="form-group">
        <label class="form-label">Komentář (nepovinný)</label>
        <textarea class="form-textarea" id="rev-comment" placeholder="Jak chutnalo? Co příště jinak?"></textarea>
      </div>
      <button class="btn btn-primary btn-block" id="rev-save">Uložit hodnocení</button>`,
  });
  const picker = createStarPicker(sheet.body.querySelector('#rev-stars'));
  sheet.body.querySelector('#rev-save').addEventListener('click', async () => {
    if (!picker.value) { toast('Vyber počet hvězdiček'); return; }
    const fresh = getRecipe(r.id);
    if (!fresh) { sheet.close(); return; }
    const updated = {
      ...fresh,
      reviews: [...(fresh.reviews || []), {
        id: uid(), author, authorUid: currentUid() || '', stars: picker.value,
        comment: sheet.body.querySelector('#rev-comment').value.trim(),
        createdAt: Date.now(),
      }]
    };
    if (await saveRecipe(updated)) { sheet.close(); toast('Díky za hodnocení'); }
  });
}

/* ================= Editor receptu (stránka) ================= */
// Rozepsaný nový recept se ukládá lokálně, aby zůstal zachovaný i po zavření
// appky nebo odchodu jinam — a šlo se k němu kdykoli vrátit tam, kde skončil.
// Týká se jen NOVÉHO receptu (rozpracovanou úpravu existujícího nedržíme).
const DRAFT_KEY = 'kucharka-draft-recipe';
function loadRecipeDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
}
function saveRecipeDraft(data) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch { /* plná kvóta / soukromý režim */ }
}
function clearRecipeDraft() { localStorage.removeItem(DRAFT_KEY); }

function renderEditorPage(editId) {
  if (editId && !state.loaded) {
    view.innerHTML = `<div class="page-narrow"><div class="skel-hero"></div></div>`;
    return;
  }
  const existing = editId ? getRecipe(editId) : null;
  if (editId && !existing) {
    view.innerHTML = `<div class="empty"><h3>Recept nenalezen</h3><p>Možná ho někdo právě smazal.</p><a class="btn btn-primary" href="#/">Zpět domů</a></div>`;
    return;
  }
  // pojistka i proti přímé URL #/upravit/<id> — upravit smí jen autor
  if (existing && !canEditRecipe(existing)) {
    toast('Recept může upravit jen jeho autor');
    location.hash = '#/recept/' + editId;
    return;
  }
  editorMounted = true;
  const isNew = !existing;
  const draft = isNew ? loadRecipeDraft() : null;
  const r = existing || {
    name: draft?.name || '', category: '', author: '',
    cookTime: draft ? (parseInt(draft.hours) || 0) * 60 + (parseInt(draft.mins) || 0) : 0,
    portions: draft?.portions || 4,
    ingredients: draft?.ingredients || [], steps: draft?.steps || [], photo: draft?.photo || '',
  };
  const hours = Math.floor((parseInt(r.cookTime) || 0) / 60);
  const mins = (parseInt(r.cookTime) || 0) % 60;
  let photoData = r.photo || '';

  const ings = (r.ingredients && r.ingredients.length) ? r.ingredients.map(i => ({ ...i })) : [{ qty: '', unit: '—', name: '' }];
  const steps = (r.steps && r.steps.length) ? [...r.steps] : [''];
  let selectedCats = (draft?.categories) || recipeCategories(r);

  view.innerHTML = `
  <div class="page-narrow">
    ${isNew ? '' : `<div class="page-topbar">
      <button class="circle-btn" id="pg-back" aria-label="Zpět">${backSvg}</button>
      <span class="spacer"></span>
    </div>`}
    <div class="page-head">
      <div class="ph-text">
        <div class="page-title">${isNew ? 'Nový recept' : 'Upravit recept'}</div>
        <div class="page-sub">${isNew ? 'Přidej ho do sbírky' : escapeHtml(r.name)}</div>
      </div>
    </div>

    <div class="form-card">
      <div class="field-row field-input">
        <input class="field-control" id="f-name" value="${escapeHtml(r.name)}" placeholder="Název receptu" maxlength="120">
      </div>
      <button type="button" class="field-row" id="f-cat-row">
        <span class="field-label">Kategorie</span>
        <span class="field-value" id="f-cat-value"></span>
        <span class="row-chevron">›</span>
      </button>
      <div class="field-row">
        <span class="field-label">Autor</span>
        <span class="field-value">${escapeHtml(isNew ? myName() : (r.author || myName()))}</span>
      </div>
      <div class="field-row">
        <span class="field-label">Doba přípravy</span>
        <div class="field-time">
          <input id="f-hours" type="number" min="0" max="48" inputmode="numeric" value="${hours || ''}" placeholder="0"><span>h</span>
          <input id="f-mins" type="number" min="0" max="59" inputmode="numeric" value="${mins || ''}" placeholder="0"><span>min</span>
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">Počet porcí</span>
        <input class="field-num" id="f-portions" type="number" min="1" max="99" inputmode="numeric" value="${escapeHtml(String(r.portions || ''))}" placeholder="4">
      </div>
    </div>

    <div class="form-section">
      <h3 class="section-label">Ingredience</h3>
      <div id="f-ings"></div>
      <button type="button" class="add-row-btn" id="f-add-ing">＋ Přidat ingredienci</button>
    </div>

    <div class="form-section">
      <h3 class="section-label">Postup</h3>
      <div id="f-steps"></div>
      <button type="button" class="add-row-btn" id="f-add-step">＋ Přidat krok</button>
    </div>

    <div class="form-section">
      <h3 class="section-label">Fotka</h3>
      <button type="button" class="photo-picker" id="f-photo-btn"></button>
      <input type="file" id="f-photo-input" accept="image/*" hidden>
    </div>

    <button class="btn btn-primary btn-block" id="f-save">${isNew ? 'Přidat recept' : 'Uložit změny'}</button>
  </div>`;

  // Nový recept je normální záložka (viz updateTabs) — bez „zpět" a bez gesta
  // swipe-back z okraje; úprava existujícího receptu zůstává vnořená obrazovka.
  if (isNew) {
  } else {
    view.querySelector('#pg-back').addEventListener('click', () => goBack('#/recept/' + editId));
  }

  // — rozepsaný nový recept: průběžné ukládání konceptu —
  function saveDraftIfNew() {
    if (!isNew) return;
    syncIngsFromDom(); syncStepsFromDom();
    saveRecipeDraft({
      name: view.querySelector('#f-name')?.value || '',
      categories: selectedCats,
      hours: view.querySelector('#f-hours')?.value || '',
      mins: view.querySelector('#f-mins')?.value || '',
      portions: view.querySelector('#f-portions')?.value || '',
      ingredients: ings,
      steps,
      photo: photoData,
    });
  }
  if (isNew) {
    view.addEventListener('input', saveDraftIfNew);
    view.addEventListener('change', saveDraftIfNew);
  }

  /* — fotka — */
  const photoBtn = view.querySelector('#f-photo-btn');
  const photoInput = view.querySelector('#f-photo-input');
  function renderPhoto() {
    photoBtn.innerHTML = photoData
      ? `<img src="${escapeHtml(photoData)}" alt=""><span class="photo-remove" id="f-photo-rm">✕</span>`
      : `${cameraSvg}<span>Přidat fotku jídla</span>`;
  }
  renderPhoto();
  photoBtn.addEventListener('click', e => {
    if (e.target.id === 'f-photo-rm') { photoData = ''; renderPhoto(); saveDraftIfNew(); return; }
    photoInput.click();
  });
  photoInput.addEventListener('change', async () => {
    const f = photoInput.files[0];
    if (!f) return;
    showLoader('Zpracovávám fotku…');
    try { photoData = await compressImage(f); renderPhoto(); saveDraftIfNew(); }
    catch { alertDialog('Chyba', 'Fotku se nepodařilo načíst.'); }
    hideLoader();
    photoInput.value = '';
  });

  /* — ingredience — */
  const ingsWrap = view.querySelector('#f-ings');
  function renderIngRows() {
    ingsWrap.innerHTML = ings.map((i, idx) => `
      <div class="ing-edit-row" data-idx="${idx}">
        <input class="form-input ing-qty-in" placeholder="2" value="${escapeHtml(String(i.qty ?? ''))}" inputmode="decimal">
        <div class="form-select-wrap" style="width:88px;flex-shrink:0">
          <select class="form-select ing-unit-in">
            ${UNITS.map(u => `<option ${u === i.unit ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
        <input class="form-input ing-name-in" placeholder="např. hladká mouka" value="${escapeHtml(i.name || '')}">
        <button type="button" class="row-del" data-del="${idx}" aria-label="Odebrat">✕</button>
      </div>`).join('');
  }
  function syncIngsFromDom() {
    ingsWrap.querySelectorAll('.ing-edit-row').forEach(row => {
      const idx = +row.dataset.idx;
      ings[idx] = {
        qty: row.querySelector('.ing-qty-in').value.trim(),
        unit: row.querySelector('.ing-unit-in').value,
        name: row.querySelector('.ing-name-in').value.trim(),
      };
    });
  }
  renderIngRows();
  view.querySelector('#f-add-ing').addEventListener('click', () => {
    syncIngsFromDom();
    ings.push({ qty: '', unit: '—', name: '' });
    renderIngRows();
    ingsWrap.querySelector('.ing-edit-row:last-child .ing-name-in')?.focus();
    saveDraftIfNew();
  });
  ingsWrap.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    syncIngsFromDom();
    ings.splice(+del.dataset.del, 1);
    if (!ings.length) ings.push({ qty: '', unit: '—', name: '' });
    renderIngRows();
    saveDraftIfNew();
  });

  /* — kroky — */
  const stepsWrap = view.querySelector('#f-steps');
  function renderStepRows() {
    stepsWrap.innerHTML = steps.map((s, idx) => `
      <div class="step-edit-row" data-idx="${idx}">
        <span class="step-num">${idx + 1}</span>
        <textarea class="form-textarea" placeholder="Popiš krok…">${escapeHtml(s)}</textarea>
        <button type="button" class="row-del" data-del="${idx}" aria-label="Odebrat">✕</button>
      </div>`).join('');
  }
  function syncStepsFromDom() {
    stepsWrap.querySelectorAll('.step-edit-row').forEach(row => {
      steps[+row.dataset.idx] = row.querySelector('textarea').value;
    });
  }
  renderStepRows();
  view.querySelector('#f-add-step').addEventListener('click', () => {
    syncStepsFromDom();
    steps.push('');
    renderStepRows();
    stepsWrap.querySelector('.step-edit-row:last-child textarea')?.focus();
    saveDraftIfNew();
  });
  stepsWrap.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    syncStepsFromDom();
    steps.splice(+del.dataset.del, 1);
    if (!steps.length) steps.push('');
    renderStepRows();
    saveDraftIfNew();
  });

  /* — kategorie (víc najednou) — */
  const catValueEl = view.querySelector('#f-cat-value');
  function refreshCatValue() {
    catValueEl.textContent = selectedCats.length ? selectedCats.join(', ') : 'Bez kategorie';
  }
  refreshCatValue();
  view.querySelector('#f-cat-row').addEventListener('click', () => {
    openCategoryPicker(selectedCats, next => { selectedCats = next; refreshCatValue(); saveDraftIfNew(); });
  });

  /* — uložení — */
  view.querySelector('#f-save').addEventListener('click', async () => {
    const name = view.querySelector('#f-name').value.trim();
    if (!name) { toast('Vyplň název receptu'); view.querySelector('#f-name').focus(); return; }
    syncIngsFromDom(); syncStepsFromDom();
    const author = isNew ? myName() : (r.author || myName());
    const cookTime = (parseInt(view.querySelector('#f-hours').value) || 0) * 60 + (parseInt(view.querySelector('#f-mins').value) || 0);
    const portions = parseInt(view.querySelector('#f-portions').value) || 0;

    const data = {
      id: isNew ? uid() : editId,
      name,
      categories: selectedCats,
      author,
      // uid autora kvůli vlastnictví (upravit/smazat smí jen autor) — u staršího
      // receptu bez uid ho doplní první úprava (upravovat ho stejně smí jen autor)
      authorUid: isNew ? (currentUid() || '') : (r.authorUid || currentUid() || ''),
      cookTime,
      portions,
      ingredients: ings.filter(i => i.name),
      steps: steps.map(s => s.trim()).filter(Boolean),
      photo: photoData,
      reviews: r.reviews || [],
      shared: r.shared || false,
      createdAt: isNew ? Date.now() : (r.createdAt || Date.now()),
      ...(isNew ? {} : { updatedAt: Date.now() }),
    };
    if (await saveRecipe(data)) {
      if (isNew) clearRecipeDraft();
      toast(isNew ? 'Recept přidán' : 'Změny uloženy');
      detailId = null; // ať se porce v detailu načtou znovu
      location.hash = '#/recept/' + data.id;
    }
  });
}

// Výběr více kategorií pro recept: seznam s fajfkou u vybraných (klepnutí přepíná),
// stejný vizuální jazyk jako Spravovat kategorie. Dole možnost rovnou založit novou
// kategorii, ať uživatel nemusí formulář opouštět (recept na polévku z mušlí typicky
// potřebuje kategorii, kterou ještě nikdo nezaložil).
function openCategoryPicker(initialSelected, onChange) {
  const selected = new Set(initialSelected);
  const sheet = openSheet({ title: 'Kategorie', bodyHtml: '' });

  function renderList() {
    sheet.body.innerHTML = `
      <p class="muted" style="font-size:13px;margin:0 0 12px">Recept může patřit do víc kategorií najednou.</p>
      <div class="settings-card" id="cp-list">
        ${state.categories.map(c => `
          <button type="button" class="settings-row cp-row" data-cat="${escapeHtml(c)}">
            <span class="row-label">${catGlyph(c)} ${escapeHtml(c)}</span>
            ${selected.has(c) ? checkAccentSvg : ''}
          </button>`).join('') || '<p class="muted" style="padding:14px;margin:0;font-size:14px">Žádné kategorie</p>'}
      </div>
      <button class="btn btn-accent btn-block" id="cp-add" style="margin-top:10px">＋ Nová kategorie</button>`;

    sheet.body.querySelectorAll('.cp-row').forEach(row => row.addEventListener('click', () => {
      const cat = row.dataset.cat;
      if (selected.has(cat)) selected.delete(cat); else selected.add(cat);
      onChange([...selected]);
      renderList();
    }));
    sheet.body.querySelector('#cp-add').addEventListener('click', () => {
      openCategoryEditor(null, () => {
        // nově založenou kategorii (poslední v seznamu) rovnou vybereme
        const created = state.categories[state.categories.length - 1];
        if (created) selected.add(created);
        onChange([...selected]);
        renderList();
      });
    });
  }
  renderList();
}

/* ================= Správa kategorií (sheet) ================= */
function openCategoryManager() {
  const sheet = openSheet({ title: 'Kategorie', bodyHtml: '' });

  function closeSwipes(listEl, except) {
    listEl.querySelectorAll('.catman-row.open').forEach(r => {
      if (r === except) return;
      if (r._swipeReset) r._swipeReset();
      else { r.classList.remove('open'); const c = r.querySelector('.cm-content'); if (c) c.style.transform = ''; }
    });
  }

  function renderList() {
    sheet.body.innerHTML = `
      <div class="settings-card catman-list" id="catman-list">
        ${state.categories.map(c => `
          <div class="catman-row" data-cat="${escapeHtml(c)}">
            <button class="cm-swipe-delete" type="button" tabindex="-1">Smazat</button>
            <div class="cm-content">
              <span class="cm-name"><span class="cm-text">${escapeHtml(c)}</span><span class="cm-count">${catCount(c)}</span></span>
              <button class="cm-rename" aria-label="Přejmenovat">${pencilSvg}</button>
              <button class="drag-handle" aria-label="Přesunout pořadí">${dragSvg}</button>
            </div>
          </div>`).join('') || '<p class="muted" style="padding:14px;margin:0;font-size:14px">Žádné kategorie</p>'}
      </div>
      <button class="btn btn-primary btn-block" id="cat-add" style="margin-top:14px">Přidat kategorii</button>`;

    sheet.body.querySelector('#cat-add').addEventListener('click', () => openCategoryEditor(null, renderList));

    const listEl = sheet.body.querySelector('#catman-list');

    async function deleteCat(cat) {
      await deleteCategoryEverywhere(cat);
      renderList();
    }

    listEl.querySelectorAll('.cm-rename').forEach(btn =>
      btn.addEventListener('click', () => openCategoryEditor(btn.closest('.catman-row').dataset.cat, renderList)));
    listEl.querySelectorAll('.cm-swipe-delete').forEach(btn =>
      btn.addEventListener('click', () => deleteCat(btn.closest('.catman-row').dataset.cat)));

    enableSwipeToDelete(listEl, deleteCat);
    enableDragReorder(listEl);
  }

  // Swipe zprava doleva odhalí zaoblené „Smazat", které narůstá s tahem;
  // dotažení přes půl řádku smaže rovnou (jako fronta v Apple Podcasts).
  function enableSwipeToDelete(listEl, deleteCat) {
    const BTN = 88;           // klidová šířka tlačítka
    const RIGHT = 12;         // odsazení tlačítka od pravého kraje
    const GAP = 8;            // mezera mezi obsahem a tlačítkem
    const OPENX = BTN + RIGHT + GAP;   // posun obsahu v otevřeném stavu
    const OPEN_TRIGGER = 46;  // práh pro zaskočení do otevřeného stavu

    listEl.querySelectorAll('.cm-content').forEach(content => {
      const row = content.closest('.catman-row');
      const delBtn = row.querySelector('.cm-swipe-delete');
      let s = null;

      // tlačítko roste tak, aby vyplnilo odhalenou plochu (efekt „rozšíření" jako v iOS)
      function apply(x) {
        content.style.transform = `translateX(${x}px)`;
        delBtn.style.width = Math.max(BTN, -x - RIGHT - GAP) + 'px';
      }
      function reset() { content.style.transform = ''; delBtn.style.width = ''; row.classList.remove('open'); }
      row._swipeReset = reset;

      content.addEventListener('pointerdown', e => {
        if (e.target.closest('.drag-handle') || e.target.closest('.cm-rename')) return;
        s = { x0: e.clientX, y0: e.clientY, base: row.classList.contains('open') ? -OPENX : 0, decided: false, horiz: false, dx: 0, w: content.offsetWidth };
      });
      content.addEventListener('pointermove', e => {
        if (!s) return;
        const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
        if (!s.decided) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          s.decided = true;
          s.horiz = Math.abs(dx) > Math.abs(dy);
          if (s.horiz) { row.classList.add('swiping'); closeSwipes(listEl, row); try { content.setPointerCapture(e.pointerId); } catch { /* syntetické eventy */ } }
          else { s = null; return; }
        }
        e.preventDefault();
        const x = Math.max(-(s.w - RIGHT), Math.min(0, s.base + dx));
        s.dx = x;
        apply(x);
      });
      const finish = () => {
        if (!s) return;
        const st = s; s = null;
        row.classList.remove('swiping');
        if (!st.horiz) return;
        row._swiped = true;
        if (-st.dx >= st.w * 0.5) { deleteCat(row.dataset.cat); return; }   // full-swipe smaže
        if (-st.dx >= OPEN_TRIGGER) { apply(-OPENX); row.classList.add('open'); }
        else reset();
      };
      content.addEventListener('pointerup', finish);
      content.addEventListener('pointercancel', finish);

      // klepnutí (ne swipe) zavře otevřené řádky
      content.addEventListener('click', e => {
        if (row._swiped) { row._swiped = false; return; }
        if (e.target.closest('.drag-handle') || e.target.closest('.cm-rename')) return;
        if (row.classList.contains('open')) reset();
        else closeSwipes(listEl);
      });
    });
  }

  // Přeřazení podržením úchytu a tažením. Tažený řádek sleduje prst/kurzor,
  // ostatní řádky plynule uhýbají přes CSS transform; DOM se přeskládá až po puštění.
  function enableDragReorder(listEl) {
    let drag = null;

    listEl.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        closeSwipes(listEl);
        const row = handle.closest('.catman-row');
        const rows = [...listEl.querySelectorAll('.catman-row')];
        drag = {
          row, rows,
          startIndex: rows.indexOf(row),
          curIndex: rows.indexOf(row),
          startY: e.clientY,
          rowH: row.offsetHeight,
        };
        row.classList.add('dragging');
        rows.forEach(r => { if (r !== row) r.style.transition = 'transform .18s ease'; });
        try { handle.setPointerCapture(e.pointerId); } catch { /* syntetické eventy */ }
      });

      handle.addEventListener('pointermove', e => {
        if (!drag) return;
        const dy = e.clientY - drag.startY;
        drag.row.style.transform = `translateY(${dy}px)`;
        const target = Math.max(0, Math.min(drag.rows.length - 1,
          drag.startIndex + Math.round(dy / drag.rowH)));
        if (target === drag.curIndex) return;
        drag.curIndex = target;
        drag.rows.forEach((r, i) => {
          if (r === drag.row) return;
          let shift = 0;
          if (drag.startIndex < target && i > drag.startIndex && i <= target) shift = -drag.rowH;
          else if (drag.startIndex > target && i >= target && i < drag.startIndex) shift = drag.rowH;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      });

      const finish = async () => {
        if (!drag) return;
        const { rows, row, startIndex, curIndex } = drag;
        drag = null;
        rows.forEach(r => { r.style.transition = ''; r.style.transform = ''; });
        row.classList.remove('dragging');
        if (curIndex !== startIndex) {
          const order = rows.map(r => r.dataset.cat);
          const [moved] = order.splice(startIndex, 1);
          order.splice(curIndex, 0, moved);
          state.categories = order;
          await saveCategories();
          onDataChanged();
          renderList();
        }
      };
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });
  }

  renderList();
}

// Editor kategorie (nová i úprava): název + barva dlaždice + emoji.
// Pořadí předvoleb v duhovém pořadí (odkazuje na stejné indexy jako CSS třídy .g0–.g8,
// takže dřív uložené kategorie zůstanou barevně beze změny).
const PRESET_COLOR_ORDER = [6, 1, 3, 0, 7, 4, 5, 2, 8];
// Plná (nikoli přechodová) barva pro tečku v pickeru — první odstín gradientu dané předvolby.
const PRESET_DOT_HEX = { 0: '#4E9159', 1: '#F7B733', 2: '#E05275', 3: '#56AB2F', 4: '#36B3C9', 5: '#7F53AC', 6: '#C33764', 7: '#0BA360', 8: '#8D6E63' };

function openCategoryEditor(existingName, onDone) {
  const isNew = !existingName;
  const style = (!isNew && state.catStyles[existingName]) || {};
  let name = existingName || '';
  let color = (typeof style.color === 'string' || Number.isInteger(style.color))
    ? style.color
    : (parseInt(catGrad(existingName || 'x').slice(1), 10) || 1);
  let emoji = style.emoji || '';

  const sheet = openSheet({ title: isNew ? 'Nová kategorie' : 'Upravit kategorii', bodyHtml: `
    <div class="cat-editor">
      <div class="cat-preview" id="cat-prev"><span class="cat-prev-glyph" id="cat-prev-glyph"></span></div>
      <div class="form-group">
        <label class="form-label">Název</label>
        <input class="form-input" id="ce-name" value="${escapeHtml(name)}" placeholder="např. Grilování" maxlength="40">
      </div>
      <div class="form-group">
        <label class="form-label">Barva</label>
        <div class="color-dots" id="ce-colors">
          ${PRESET_COLOR_ORDER.map(i => `<button type="button" class="dot${color === i ? ' sel' : ''}" data-color="${i}" style="background:${PRESET_DOT_HEX[i]}" aria-label="Předvolená barva">${checkSvg}</button>`).join('')}
          <label class="dot dot-custom${typeof color === 'string' ? ' sel' : ''}" id="ce-custom-wrap" aria-label="Vlastní barva">
            <input type="color" id="ce-color-native" value="${typeof color === 'string' ? color : '#4E9159'}">
            <span class="dot-custom-ring"></span>${checkSvg}
          </label>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Emoji <span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">(nepovinné — jinak písmeno)</span></label>
        <div class="emoji-row">
          <button type="button" class="emoji-trigger" id="ce-emoji-btn"></button>
          <button type="button" class="btn btn-sm" id="ce-emoji-clear">Písmeno</button>
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="ce-save">${isNew ? 'Přidat kategorii' : 'Uložit'}</button>
    </div>` });

  const body = sheet.body;
  const prev = body.querySelector('#cat-prev');
  const prevGlyph = body.querySelector('#cat-prev-glyph');
  const nameInput = body.querySelector('#ce-name');
  const emojiBtn = body.querySelector('#ce-emoji-btn');
  const customInput = body.querySelector('#ce-color-native');
  const customWrap = body.querySelector('#ce-custom-wrap');

  function refreshPreview() {
    if (typeof color === 'string') {
      prev.className = 'cat-preview';
      prev.style.cssText = `background:linear-gradient(135deg,${color},${darkenHex(color)})`;
    } else {
      prev.className = 'cat-preview g' + color;
      prev.style.cssText = '';
    }
    const g = emoji || (name.trim() ? name.trim()[0].toLocaleUpperCase('cs') : '?');
    prevGlyph.textContent = g;
    prevGlyph.classList.toggle('is-emoji', isEmojiGlyph(g));
    emojiBtn.textContent = emoji || '＋';
    emojiBtn.classList.toggle('is-emoji', isEmojiGlyph(emoji));
  }
  refreshPreview();

  function selectColor(val) {
    color = val;
    body.querySelectorAll('.dot').forEach(s => s.classList.remove('sel'));
    if (typeof val === 'string') customWrap.classList.add('sel');
    else body.querySelector(`.dot[data-color="${val}"]`)?.classList.add('sel');
    refreshPreview();
  }

  nameInput.addEventListener('input', () => { name = nameInput.value; refreshPreview(); });

  body.querySelector('#ce-colors').addEventListener('click', e => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    selectColor(+b.dataset.color);
  });
  customInput.addEventListener('input', () => selectColor(customInput.value));
  emojiBtn.addEventListener('click', () => {
    openEmojiPicker(picked => { emoji = picked; refreshPreview(); });
  });
  body.querySelector('#ce-emoji-clear').addEventListener('click', () => {
    emoji = ''; refreshPreview();
  });

  body.querySelector('#ce-save').addEventListener('click', async () => {
    const finalName = nameInput.value.trim();
    if (!finalName) { toast('Vyplň název kategorie'); nameInput.focus(); return; }
    const clash = state.categories.some(c => c === finalName && c !== existingName);
    if (clash) { toast('Kategorie s tímto názvem už existuje'); return; }

    const styleObj = {};
    styleObj.color = color;
    if (emoji) styleObj.emoji = emoji;

    if (isNew) {
      state.categories.push(finalName);
      state.catStyles[finalName] = styleObj;
      await saveCategories();
      await saveCatStyles();
      onDataChanged();
    } else {
      if (finalName !== existingName) {
        await renameCategoryEverywhere(existingName, finalName); // přesune i styl na nový klíč
      }
      state.catStyles[finalName] = styleObj;
      await saveCatStyles();
      onDataChanged();
    }
    sheet.close();
    onDone && onDone();
  });

  setTimeout(() => { if (isNew) nameInput.focus(); }, 80);
}

/* ================= Vlastní picker emoji (napodobuje iOS emoji klávesnici) =================
   Web nemá API na vynucené otevření systémového emoji pickeru přímo na kategorii jídla,
   proto stavíme vlastní: pruh kategorií nahoře (jako spodní lišta klávesnice na iOS,
   žádné vyhledávání — přesně jako skutečná iOS klávesnice) + posuvná mřížka pod ním,
   výchozí otevření rovnou na „Jídlo a pití". */
const EMOJI_CATEGORIES = [
  // Přesná kopie oficiální Unicode kategorie „Food & Drink" (131 položek, v tomto pořadí) —
  // NEDOPLŇOVAT sem mořské živočichy (krab/humr/kreveta/chobotnice/ústřice) ani houbu,
  // ty patří podle Unicode/iOS pod „Animals & Nature", viz kategorie animals níže.
  // Pořadí přesně podle skutečného macOS/iOS emoji pickeru (dle screenshotů), NE podle
  // dřívějšího webového zdroje — Apple řadí bloky jinak (ovoce→zelenina→pečivo→maso→
  // asijská kuchyně→sladkosti→svačiny→nápoje→nádobí naposled), než jak to mělo emojiguide.com.
  { key: 'food', label: 'Jídlo a pití', icon: '🍔', emojis: '🍏 🍎 🍐 🍊 🍋 🍋‍🟩 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🫛 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🫜 🍠 🫚 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🦴 🌭 🍔 🍟 🍕 🫓 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🍜 🥫 🫙 🍝 🍢 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🫘 🍯 🥛 🫗 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍽️ 🍴 🥣 🥡 🥢 🧂'.split(' ') },
  { key: 'smileys', label: 'Smajlíci a lidé', icon: '😀', emojis: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😜 🤪 🤗 🤔 🤨 😐 😴 🥳 😎 🧐 🙁 😢 😭 😡 🥺 🤯 😤 👍 👎 👏 🙌 🤝 🙏 💪 👋'.split(' ') },
  { key: 'animals', label: 'Zvířata a příroda', icon: '🐶', emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🐢 🐍 🦎 🐙 🦀 🦞 🦐 🦑 🐠 🐬 🐳 🐘 🦒 🍄 🌵 🌲 🌳 🌴 🌸 🌻 🌹 🍀 🌈 ☀️ 🌙 ⭐ ☁️ ❄️'.split(' ') },
  { key: 'activities', label: 'Aktivity', icon: '⚽', emojis: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 ⛳ 🎣 🎿 🏂 🏋️ 🤸 🚴 🏆 🥇 🎮 🎲 🎯 🎨 🎭 🎪 🎬 🎤 🎧 🎸 🎹 🥁'.split(' ') },
  { key: 'travel', label: 'Cestování a místa', icon: '✈️', emojis: '🚗 🚕 🚙 🚌 🚓 🚑 🚒 🚚 🚲 🛵 ✈️ 🚀 🚁 ⛵ 🚢 🚂 🗽 🗼 🏰 ⛰️ 🏔️ 🌋 🏖️ 🏝️ 🏕️ ⛺ 🏠 🏡 🏢 🏛️ ⛪ 🕌 🌇 🌆 🌃 🌉 🗺️'.split(' ') },
  { key: 'objects', label: 'Předměty', icon: '💡', emojis: '💡 🔦 🕯️ 🧯 💰 💵 💳 📱 💻 ⌚ 📷 🎥 📺 📻 ⏰ 🔑 🔒 🔨 🔧 🧰 🧲 🎁 🎈 🎉 🎀 🛍️ 👓 👔 👗 👞 💍 💎'.split(' ') },
  { key: 'symbols', label: 'Symboly', icon: '❤️', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💯 ✅ ❌ ⭕ ❗ ❓ 💤 💢 💥 🔥 ✨ ⭐ 🌟 💫 🔔'.split(' ') },
];
const RECENT_EMOJI_KEY = 'kucharka-recent-emoji';
function getRecentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || '[]'); } catch { return []; }
}
function addRecentEmoji(e) {
  const list = [e, ...getRecentEmoji().filter(x => x !== e)].slice(0, 24);
  localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(list));
}

function openEmojiPicker(onPick) {
  const recent = getRecentEmoji();
  const cats = (recent.length ? [{ key: 'recent', label: 'Nedávné', icon: '🕐', emojis: recent }] : []).concat(EMOJI_CATEGORIES);

  const sheet = openSheet({
    title: 'Emoji',
    bodyHtml: `
      <div class="emoji-picker">
        <div class="ep-tabs" id="ep-tabs">
          ${cats.map(c => `<button type="button" class="ep-tab" data-cat="${c.key}" aria-label="${escapeHtml(c.label)}">${c.icon}</button>`).join('')}
        </div>
        <div class="ep-scroll" id="ep-scroll">
          ${cats.map(c => `
            <section class="ep-section" data-sec="${c.key}">
              <h4 class="ep-sec-label">${escapeHtml(c.label)}</h4>
              <div class="ep-grid">${c.emojis.map(e => `<button type="button" class="ep-emoji" data-emoji="${e}">${e}</button>`).join('')}</div>
            </section>`).join('')}
        </div>
      </div>`,
  });

  const body = sheet.body;
  const tabsEl = body.querySelector('#ep-tabs');
  const scrollEl = body.querySelector('#ep-scroll');
  const sections = [...body.querySelectorAll('.ep-section')];
  let syncing = false;

  // Pozice sekce v rámci scroll kontejneru. .ep-scroll je position:relative, takže
  // je přímým offsetParentem sekcí — na rozdíl od getBoundingClientRect to funguje
  // spolehlivě i uprostřed otevírací animace panelu (transform ho neovlivňuje).
  function sectionTop(sec) { return sec.offsetTop; }

  function setActiveTab(key) {
    tabsEl.querySelectorAll('.ep-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === key));
  }
  tabsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    const sec = body.querySelector(`.ep-section[data-sec="${b.dataset.cat}"]`);
    if (!sec) return;
    syncing = true;
    scrollEl.scrollTo({ top: sectionTop(sec), behavior: 'smooth' });
    setActiveTab(b.dataset.cat);
    setTimeout(() => { syncing = false; }, 400);
  });
  scrollEl.addEventListener('scroll', () => {
    if (syncing) return;
    const top = scrollEl.scrollTop + 4;
    const maxTop = scrollEl.scrollHeight - scrollEl.clientHeight - 2;
    let current = sections[0];
    for (const s of sections) { if (sectionTop(s) <= Math.min(top, maxTop) || top >= maxTop) current = s; }
    setActiveTab(current.dataset.sec);
  }, { passive: true });

  body.addEventListener('click', e => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    const picked = b.dataset.emoji;
    addRecentEmoji(picked);
    sheet.close();
    onPick(picked);
  });

  // Výchozí otevření rovnou na „Jídlo a pití" (u vaření nejužitečnější kategorie).
  const food = body.querySelector('.ep-section[data-sec="food"]');
  if (food) scrollEl.scrollTop = sectionTop(food);
  setActiveTab('food');
}

/* ================= Nastavení (stránka) ================= */
function renderSettingsPage() {
  const pref = getThemePref();
  const me = myName();
  const loggedIn = !DEMO && !guestMode && !guestDemoFallback;   // skutečný účet (heslo, odhlášení, allowlist)
  const canEdit = !guestMode && !publicMode && !guestDemoFallback;  // úprava jména/fotky/barvy — i v demu
  const init = profileInitial();
  const photo = photoFor(me);
  view.innerHTML = `
  <div class="page-narrow">
    <div class="page-topbar">
      <button class="circle-btn" id="prof-back" aria-label="Zpět">${backSvg}</button>
      <span class="spacer"></span>
    </div>
    <div class="page-head page-head-center">
      <div class="ph-text">
        <button class="profile-hero-avatar ${photo || init ? '' : 'avatar-empty'}" id="prof-avatar" ${(!photo && init) ? `style="background:${avatarColor()}"` : ''} aria-label="${canEdit ? 'Upravit profilovou fotku a barvu' : 'Profil'}">
          ${avatarInnerHtml()}
        </button>
        <div class="page-title">${escapeHtml(me || 'Host')}</div>
        <div class="page-sub">${loggedIn ? 'tvůj profil a nastavení' : guestMode ? 'prohlížíš jako host' : 'ukázkový režim'}</div>
      </div>
    </div>

    <div class="settings-group">
      <h3>Vzhled</h3>
      <div class="settings-card">
        <div class="settings-row">
          <span class="row-label">Režim</span>
          <div class="theme-seg">
            <button class="${pref === 'light' ? 'active' : ''}" data-theme-set="light">Světlý</button>
            <button class="${pref === 'dark' ? 'active' : ''}" data-theme-set="dark">Tmavý</button>
            <button class="${pref === 'system' ? 'active' : ''}" data-theme-set="system">Systém</button>
          </div>
        </div>
      </div>
    </div>

    ${guestMode || guestDemoFallback ? `
    <div class="settings-group">
      <h3>Účet</h3>
      <div class="settings-card">
        <button class="settings-row" id="set-login">
          <span class="row-label" style="color:var(--accent);font-weight:700">Přihlásit se</span><span class="row-chevron">›</span>
        </button>
      </div>
    </div>` : ''}

    ${canEdit ? `
    <div class="settings-group">
      <h3>Účet</h3>
      <div class="settings-card">
        <button class="settings-row" id="set-rename">
          <span class="row-label">Jméno</span><span class="row-chevron">${escapeHtml(me)} ›</span>
        </button>
        <button class="settings-row" id="set-photo">
          <span class="row-label">Profilová fotka</span><span class="row-chevron">${photo ? 'Změnit' : 'Přidat'} ›</span>
        </button>
        ${loggedIn && hasPasswordProvider() ? `
        <button class="settings-row" id="set-password">
          <span class="row-label">Změnit heslo</span><span class="row-chevron">›</span>
        </button>` : ''}
        ${loggedIn ? `
        <button class="settings-row" id="set-signout">
          <span class="row-label" style="color:var(--danger)">Odhlásit se</span>
        </button>` : ''}
      </div>
    </div>` : ''}

    ${loggedIn && state.accessRequests.length ? `
    <div class="settings-group">
      <h3>Žádosti o přístup</h3>
      <div class="settings-card">
        ${state.accessRequests.map(r => `
          <div class="settings-row req-row">
            ${personAvatarHtml(r.name || r.email)}
            <span class="row-label req-who">
              ${r.name ? `<b>${escapeHtml(r.name)}</b>` : ''}
              <span class="req-mail">${escapeHtml(r.email || '')}</span>
            </span>
            <span class="req-actions">
              <button class="req-no" data-req-deny="${escapeHtml(r.uid)}" aria-label="Odmítnout">✕</button>
              <button class="req-yes" data-req-ok="${escapeHtml(r.uid)}" aria-label="Pustit dovnitř">Pustit</button>
            </span>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${loggedIn ? `
    <div class="settings-group">
      <h3>Kdo má přístup</h3>
      <div class="settings-card">
        ${state.allowedEmails.map(e => `
          <div class="settings-row">
            <span class="row-label">${escapeHtml(e)}</span>
            <button data-allow-del="${escapeHtml(e)}" aria-label="Odebrat přístup">${trashSvg}</button>
          </div>`).join('')}
        <button class="settings-row" id="allow-add" style="color:var(--accent);font-weight:700">
          <span class="row-label">＋ Pozvat</span>
        </button>
      </div>
    </div>` : ''}

    ${state.profiles.length ? `
    <div class="settings-group">
      <h3>Kdo je v kuchařce</h3>
      <div class="settings-card">
        ${state.profiles.map(p => `<div class="settings-row"><span class="row-label row-with-avatar">${personAvatarHtml(p)}${escapeHtml(p)}</span></div>`).join('')}
      </div>
    </div>` : ''}

    <div class="settings-group">
      <h3>Kuchařka</h3>
      <div class="settings-card">
        ${guestMode ? '' : `
        <button class="settings-row" id="set-cats">
          <span class="row-label">Spravovat kategorie</span><span class="row-chevron">›</span>
        </button>`}
        <button class="settings-row" id="set-feedback">
          <span class="row-label">Zpětná vazba</span><span class="row-chevron">›</span>
        </button>
      </div>
    </div>

    <p class="detail-footnote">${guestMode ? 'Prohlížíš jako host · bez úprav' : guestDemoFallback ? 'Ukázková data · kuchařka je jen pro pozvané' : 'Kuchařka · uzamčeno jen pro pozvané'}</p>
  </div>`;

  view.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
    localStorage.setItem('kucharka-theme', b.dataset.themeSet);
    applyTheme();
    renderSettingsPage();
  }));

  view.querySelector('#prof-avatar')?.addEventListener('click', () => {
    if (canEdit) openProfileEditSheet();
    else if (profileInitial()) openAvatarColorPicker();  // fallback: aspoň barva, když nejde upravovat
  });
  view.querySelector('#prof-back').addEventListener('click', () => goBack('#/'));

  view.querySelector('#set-rename')?.addEventListener('click', renameProfile);
  view.querySelector('#set-photo')?.addEventListener('click', openProfileEditSheet);

  view.querySelector('#set-password')?.addEventListener('click', openChangePassword);
  view.querySelector('#set-signout')?.addEventListener('click', async () => {
    const ok = await confirmDialog('Odhlásit se?', 'Budeš se muset znovu přihlásit.', { okLabel: 'Odhlásit' });
    if (ok) await signOutUser();
  });

  view.querySelector('#allow-add')?.addEventListener('click', async () => {
    const email = await promptDialog('Pozvat do kuchařky', 'Zadej e-mail, který smí být přihlášen.', { placeholder: 'jméno@email.cz', okLabel: 'Pozvat' });
    if (!email) return;
    try {
      state.allowedEmails = await addAllowedEmail(email);
      toast('Pozváno — ať si založí účet se stejným e-mailem');
      renderSettingsPage();
    } catch { alertDialog('Nepovedlo se', 'E-mail se nepodařilo přidat.'); }
  });
  view.querySelectorAll('[data-allow-del]').forEach(b => b.addEventListener('click', async () => {
    const email = b.dataset.allowDel;
    const ok = await confirmDialog('Odebrat přístup?', `„${email}" už se nebude moct přihlásit.`, { okLabel: 'Odebrat', danger: true });
    if (!ok) return;
    try {
      state.allowedEmails = await removeAllowedEmail(email);
      renderSettingsPage();
    } catch { alertDialog('Nepovedlo se', 'Přístup se nepodařilo odebrat.'); }
  }));

  // žádosti o přístup: „Pustit" přidá e-mail na seznam a žádost smaže
  view.querySelectorAll('[data-req-ok]').forEach(b => b.addEventListener('click', async () => {
    const req = state.accessRequests.find(r => r.uid === b.dataset.reqOk);
    if (!req?.email) return;
    b.disabled = true;
    try {
      state.allowedEmails = await addAllowedEmail(req.email);
      await deleteDoc(doc(db, 'accessRequests', req.uid));
      toast(`${req.name || req.email} má přístup`);
    } catch (e) { console.error(e); alertDialog('Nepovedlo se', 'Přístup se nepodařilo udělit.'); b.disabled = false; }
  }));
  view.querySelectorAll('[data-req-deny]').forEach(b => b.addEventListener('click', async () => {
    const req = state.accessRequests.find(r => r.uid === b.dataset.reqDeny);
    if (!req) return;
    const ok = await confirmDialog('Odmítnout žádost?', `„${req.email}" se do kuchařky nedostane. Požádat může znovu.`, { okLabel: 'Odmítnout', danger: true });
    if (!ok) return;
    try { await deleteDoc(doc(db, 'accessRequests', req.uid)); }
    catch (e) { console.error(e); alertDialog('Nepovedlo se', 'Žádost se nepodařilo odmítnout.'); }
  }));

  view.querySelector('#set-login')?.addEventListener('click', exitGuestMode);

  view.querySelector('#set-cats')?.addEventListener('click', openCategoryManager);
  view.querySelector('#set-feedback').addEventListener('click', openFeedback);
  enableGameEasterEgg(view.querySelector('.detail-footnote'));
}

function openChangePassword() {
  const sheet = openSheet({
    title: 'Změnit heslo',
    bodyHtml: `
      <div class="form-group">
        <label class="form-label">Současné heslo</label>
        <input class="form-input" type="password" id="pw-current" autocomplete="current-password">
      </div>
      <div class="form-group">
        <label class="form-label">Nové heslo</label>
        <input class="form-input" type="password" id="pw-new" autocomplete="new-password">
      </div>
      <button class="btn btn-primary btn-block" id="pw-save">Uložit heslo</button>`,
  });
  sheet.body.querySelector('#pw-save').addEventListener('click', async () => {
    const current = sheet.body.querySelector('#pw-current').value;
    const next = sheet.body.querySelector('#pw-new').value;
    if (!current || !next) { toast('Vyplň obě pole'); return; }
    if (next.length < 6) { toast('Nové heslo musí mít alespoň 6 znaků'); return; }
    try {
      await changePassword(current, next);
      sheet.close();
      toast('Heslo změněno');
    } catch (e) {
      alertDialog('Nepovedlo se', e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password'
        ? 'Současné heslo není správně.' : 'Heslo se nepodařilo změnit.');
    }
  });
}

// Změna jména — promítne se do všech receptů a hodnocení (renameProfileEverywhere).
// V demu není přihlášený uživatel, takže se přeskočí changeDisplayName (jen lokální).
async function renameProfile() {
  const oldName = myName();
  const newName = (await promptDialog('Změnit jméno', 'Změna se promítne do tvých receptů a hodnocení.', { value: oldName, okLabel: 'Uložit' }))?.trim();
  if (!newName || newName === oldName) return;
  try {
    if (!DEMO) await changeDisplayName(newName);
    await renameProfileEverywhere(oldName, newName);
    renderProfileButtons();
    if (currentRoute.page === 'settings') renderSettingsPage();
  } catch (e) {
    console.error('rename profile:', e);
    alertDialog('Nepovedlo se', 'Jméno se nepodařilo změnit.');
  }
}

// Profilová fotka (lokální, localStorage) + přístup k barvě monogramu. Otevře se
// klikem na velký avatar v nastavení nebo z řádku „Profilová fotka".
function openProfileEditSheet() {
  const hasPhoto = !!photoFor(myName());
  const hasName = !!profileInitial();
  const sheet = openSheet({
    title: 'Profilová fotka',
    bodyHtml: `
      <div class="profile-edit-list">
        <button class="btn btn-primary btn-block" id="pe-photo">${hasPhoto ? 'Změnit fotku' : 'Vybrat fotku'}</button>
        ${hasName && !hasPhoto ? `<button class="btn btn-block" id="pe-color">Změnit barvu monogramu</button>` : ''}
        ${hasPhoto ? `<button class="btn btn-block" id="pe-remove" style="color:var(--danger)">Odebrat fotku</button>` : ''}
      </div>
      <input type="file" accept="image/*" id="pe-file" hidden>`,
  });
  const file = sheet.body.querySelector('#pe-file');
  sheet.body.querySelector('#pe-photo').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    showLoader('Ukládám fotku…');
    try {
      const data = await compressImage(f, 480, 0.85);
      await setMyAvatarPhoto(data);
      renderProfileButtons();
      if (currentRoute.page === 'settings') renderSettingsPage();
      sheet.close();
    } catch (err) {
      console.error('avatar photo:', err);
      alertDialog('Nepovedlo se', 'Fotku se nepodařilo uložit. Zkus to prosím znovu.');
    }
    hideLoader();
    file.value = '';
  });
  sheet.body.querySelector('#pe-color')?.addEventListener('click', () => { sheet.close(); openAvatarColorPicker(); });
  sheet.body.querySelector('#pe-remove')?.addEventListener('click', async () => {
    showLoader('Odebírám…');
    try { await removeMyAvatarPhoto(); } catch (e) { console.error('remove avatar:', e); }
    renderProfileButtons();
    if (currentRoute.page === 'settings') renderSettingsPage();
    hideLoader();
    sheet.close();
  });
}

// Nastaví MOU fotku: lokálně (instant/offline) + když jsem přihlášený, nahraje ji
// do Storage a URL uloží do sdílené mapy meta/avatarPhotos, ať ji vidí i ostatní.
async function setMyAvatarPhoto(dataUrl) {
  localStorage.setItem('kucharka-avatar-photo', dataUrl);
  const me = myName();
  if (!DEMO && currentUid() && me) {
    const photoRef = ref(storage, 'avatars/' + currentUid() + '.jpg');
    await uploadString(photoRef, dataUrl, 'data_url', { cacheControl: 'public, max-age=31536000' });
    const url = await getDownloadURL(photoRef);
    state.avatarPhotos = { ...state.avatarPhotos, [me]: url };
    await saveAvatarPhotos();
  }
}
async function removeMyAvatarPhoto() {
  localStorage.removeItem('kucharka-avatar-photo');
  const me = myName();
  if (!DEMO && me) {
    if (state.avatarPhotos[me]) {
      const m = { ...state.avatarPhotos }; delete m[me]; state.avatarPhotos = m;
      await saveAvatarPhotos();
    }
    try { if (currentUid()) await deleteObject(ref(storage, 'avatars/' + currentUid() + '.jpg')); } catch { /* soubor nemusí existovat */ }
  }
}

// Barva profilového monogramu (obdoba výběru barvy u kategorií — plná kolečka).
function openAvatarColorPicker() {
  const cur = avatarColor();
  const sheet = openSheet({
    title: 'Barva profilu',
    bodyHtml: `
      <div class="color-dots" id="av-colors" style="margin-bottom:6px">
        ${AVATAR_COLORS.map(c => `<button type="button" class="dot${c.toLowerCase() === cur.toLowerCase() ? ' sel' : ''}" data-color="${c}" style="background:${c}" aria-label="Barva">${checkSvg}</button>`).join('')}
      </div>`,
  });
  sheet.body.querySelector('#av-colors').addEventListener('click', e => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    localStorage.setItem('kucharka-avatar-color', b.dataset.color);
    renderProfileButtons();
    renderSettingsPage();
    sheet.close();
  });
}

/* ================= Minihra „Dokonalá palačinka" (velikonoční vajíčko) =================
   Spouští se třemi klepnutími na patičku v Nastavení. Jen pro přihlášené — host
   a veřejný náhled se do ní nedostanou. Ovládání je JEDNO KLEPNUTÍ kamkoli do
   pánve, takže se hraje úplně stejně na dotyku i myší; power-upy mají vlastní
   pruh, který klepnutí polyká (jinak by použití power-upu zároveň otočilo palačinku). */

let stopGame = null;   // zastaví běžící smyčku při odchodu ze stránky (volá render())

// Tři klepnutí do 1,2 s po sobě. Krátké okno = omylem se to nespustí.
function enableGameEasterEgg(el) {
  if (!el || readOnly()) return;
  let hits = 0, timer = null;
  el.style.cursor = 'default';
  el.addEventListener('click', () => {
    hits++;
    clearTimeout(timer);
    timer = setTimeout(() => { hits = 0; }, 1200);
    if (hits >= 3) { hits = 0; clearTimeout(timer); location.hash = '#/hra'; }
  });
}

// Ikony power-upů — kreslené, ať jsou poznat na první pohled (emoji se na různých
// zařízeních liší a ve slotu se ztrácela). Barvy drží paletu appky.
const puButterSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10h14v9H5z" fill="#E5B457"/><path d="M5 10 8 6h14l-3 4z" fill="#F3D289"/><path d="M19 10l3-4v9l-3 4z" fill="#CE9A3D"/></svg>`;
const puPanSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.2 8 20.6 2.6" fill="none" stroke="#8A7660" stroke-width="2.2" stroke-linecap="round"/><circle cx="10.5" cy="14" r="6.8" fill="#4A4038"/><circle cx="10.5" cy="14" r="3.9" fill="#E5B457"/><path d="M2 11.7.6 14 2 16.3M19 11.7 20.4 14 19 16.3" fill="none" stroke="#69A874" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const puLidSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.6" r="1.9" fill="#7C8892"/><path d="M3 15.5a9 9 0 0 1 18 0z" fill="#B6C1C9"/><rect x="1.8" y="15.5" width="20.4" height="2.8" rx="1.4" fill="#8E9AA3"/></svg>`;
const puGoldenSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="11" cy="17.4" rx="8.2" ry="3.1" fill="#C08C34"/><ellipse cx="11" cy="14" rx="8.6" ry="3.3" fill="#DFA84C"/><ellipse cx="11" cy="10.6" rx="8.2" ry="3.1" fill="#F1C76C"/><path d="M19.4 3.2l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="#EFA528"/></svg>`;

// `flips` = na kolik otočení efekt vydrží (počítadlo v ukazateli aktivních efektů);
// bez `flips` je to jednorázová pojistka, která čeká, dokud ji nespustí chyba.
const POWERUPS = {
  butter: { name: 'Máslo',            desc: 'Ručička se na 3 otočky zpomalí',         icon: puButterSvg, flips: 3 },
  bigpan: { name: 'Větší pánev',      desc: 'Zelená zóna je na 3 otočky dvojnásobná', icon: puPanSvg,    flips: 3 },
  lid:    { name: 'Poklice',          desc: 'Nejbližší chyba tě nestojí život',       icon: puLidSvg },
  golden: { name: 'Zlatá palačinka',  desc: 'Při chybě si udržíš sérii',              icon: puGoldenSvg },
};
const POWERUP_IDS = Object.keys(POWERUPS);

// Žebříček: seřazená jména podle nejvyššího skóre.
function leaderboardHtml({ highlightScore = null } = {}) {
  const me = myName();
  const rows = Object.entries(state.highScores)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (!rows.length) {
    return `<div class="gm-board"><h3 class="gm-board-title">Žebříček</h3>
      <p class="gm-board-empty">Zatím nikdo nehrál. Buď první.</p></div>`;
  }
  return `<div class="gm-board">
    <h3 class="gm-board-title">Žebříček</h3>
    <ol class="gm-board-list">
      ${rows.map(([name, score], i) => `
        <li class="gm-row${name === me ? ' is-me' : ''}">
          <span class="gm-rank">${i + 1}</span>
          ${personAvatarHtml(name)}
          <span class="gm-name">${escapeHtml(name)}</span>
          <span class="gm-score">${score}</span>
        </li>`).join('')}
    </ol>
    ${highlightScore !== null && !rows.some(([n]) => n === me)
      ? `<p class="gm-board-empty">Tvoje nejlepší: ${state.highScores[me] || 0}</p>` : ''}
  </div>`;
}

function renderGamePage() {
  // hra je jen pro přihlášené; host/veřejný náhled se sem nedostane
  if (readOnly()) { toast('Hra je jen pro přihlášené'); location.hash = '#/'; return; }

  view.innerHTML = `
  <div class="page-narrow gm-wrap">
    <div class="page-topbar">
      <button class="circle-btn" id="pg-back" aria-label="Zpět do kuchařky">${backSvg}</button>
      <span class="spacer"></span>
    </div>
    <div id="gm-screen"></div>
  </div>`;
  view.querySelector('#pg-back').addEventListener('click', () => goBack('#/nastaveni'));

  const screen = view.querySelector('#gm-screen');

  function renderMenu(lastScore = null, isRecord = false) {
    screen.innerHTML = `
      <div class="gm-intro">
        ${lastScore === null
          ? `<div class="gm-logo">🥞</div>
             <h1 class="gm-title">Dokonalá palačinka</h1>
             <p class="gm-lead">Klepni, když je ručička v zelené. Trefíš zlatý střed a dostaneš power-up.</p>`
          : `<div class="gm-logo">${isRecord ? '🏆' : '🥞'}</div>
             <h1 class="gm-title">${isRecord ? 'Nový rekord!' : 'Konec'}</h1>
             <p class="gm-lead">Získal jsi <b>${lastScore}</b> ${lastScore === 1 ? 'bod' : lastScore < 5 ? 'body' : 'bodů'}.</p>`}
        <button class="btn btn-primary btn-block gm-play" id="gm-play">${lastScore === null ? 'Hrát' : 'Hrát znovu'}</button>
      </div>
      ${leaderboardHtml({ highlightScore: lastScore })}`;
    screen.querySelector('#gm-play').addEventListener('click', startRound);
  }

  function startRound() {
    screen.innerHTML = `
      <div class="gm-hud">
        <div class="gm-stat"><span class="gm-stat-k">Skóre</span><span class="gm-stat-v" id="gm-score">0</span></div>
        <div class="gm-stat"><span class="gm-stat-k">Série</span><span class="gm-stat-v" id="gm-streak">0</span></div>
        <div class="gm-stat"><span class="gm-stat-k">Životy</span><span class="gm-stat-v" id="gm-lives">●●●</span></div>
      </div>
      <div class="gm-active" id="gm-active"></div>
      <div class="gm-stage" id="gm-stage">
        <canvas id="gm-canvas"></canvas>
        <div class="gm-hint" id="gm-hint">Klepni do pánve</div>
      </div>
      <div class="gm-slots" id="gm-slots"></div>`;

    const canvas = screen.querySelector('#gm-canvas');
    const stage = screen.querySelector('#gm-stage');
    const ctx = canvas.getContext('2d');
    const elScore = screen.querySelector('#gm-score');
    const elStreak = screen.querySelector('#gm-streak');
    const elLives = screen.querySelector('#gm-lives');
    const elSlots = screen.querySelector('#gm-slots');
    const elActive = screen.querySelector('#gm-active');
    const elHint = screen.querySelector('#gm-hint');

    const S = {
      score: 0, streak: 0, lives: 3, level: 0,
      ang: 0, dir: 1, speed: 2.2,
      zoneStart: 0, zoneLen: 1.0,
      slots: [], slowFlips: 0, wideFlips: 0, shield: false, keepStreak: false,
      flash: null, flashUntil: 0, over: false, last: performance.now(),
    };

    const TAU = Math.PI * 2;
    const norm = a => ((a % TAU) + TAU) % TAU;
    const zoneLenNow = () => Math.min(S.zoneLen * (S.wideFlips > 0 ? 2 : 1), 2.2);
    const goldLenNow = () => zoneLenNow() * 0.3;

    function newZone() {
      S.zoneStart = Math.random() * TAU;
      S.zoneLen = Math.max(0.34, 1.0 - S.level * 0.042);
      S.speed = Math.min(2.2 + S.level * 0.17, 6.2);
      S.dir = Math.random() < 0.35 ? -1 : 1;
    }
    newZone();

    /* — kreslení — */
    let W = 0, H = 0, R = 0, cx = 0, cy = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rect = stage.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2;
      R = Math.min(W, H) / 2 - 16;
    }
    const onResize = () => { resize(); };
    window.addEventListener('resize', onResize);
    resize();

    const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const A = a => a - Math.PI / 2;   // 0 rad = 12 hodin

    function draw(now) {
      const dark = document.documentElement.dataset.theme === 'dark';
      ctx.clearRect(0, 0, W, H);

      const ringW = Math.max(10, R * 0.17);
      const rr = R - ringW / 2;

      // dráha ručičky
      ctx.lineWidth = ringW;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.09)' : 'rgba(90,70,45,.12)';
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.stroke();

      // zelená zóna + zlatý střed
      const zl = zoneLenNow(), gl = goldLenNow();
      const gs = S.zoneStart + (zl - gl) / 2;
      ctx.strokeStyle = dark ? '#4E8A58' : '#69A874';
      ctx.beginPath(); ctx.arc(cx, cy, rr, A(S.zoneStart), A(S.zoneStart + zl)); ctx.stroke();
      ctx.strokeStyle = '#EFA528';
      ctx.beginPath(); ctx.arc(cx, cy, rr, A(gs), A(gs + gl)); ctx.stroke();

      // pánev — plasticky: tělo + přísvit shora + stín dole uvnitř
      const pr = R - ringW - 6;
      const body = ctx.createLinearGradient(cx, cy - pr, cx, cy + pr);
      if (dark) { body.addColorStop(0, '#3B332A'); body.addColorStop(1, '#221C15'); }
      else { body.addColorStop(0, '#4A4038'); body.addColorStop(1, '#2C251F'); }
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.arc(cx, cy, pr, 0, TAU); ctx.fill();

      const sheen = ctx.createLinearGradient(cx, cy - pr, cx, cy);
      sheen.addColorStop(0, 'rgba(255,255,255,.16)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.beginPath(); ctx.arc(cx, cy, pr, 0, TAU); ctx.fill();

      // palačinka — barva podle „propečení" (roste během otočky)
      const bake = Math.min(1, S.level * 0.03);
      const cr = pr * 0.62;
      const cake = ctx.createLinearGradient(cx, cy - cr, cx, cy + cr);
      const light = `hsl(38 ${72 - bake * 22}% ${72 - bake * 18}%)`;
      const deep = `hsl(32 ${68 - bake * 20}% ${54 - bake * 16}%)`;
      cake.addColorStop(0, light); cake.addColorStop(1, deep);
      ctx.fillStyle = cake;
      ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.beginPath(); ctx.ellipse(cx, cy - cr * 0.42, cr * 0.52, cr * 0.24, 0, 0, TAU); ctx.fill();

      // ručička
      const a = A(S.ang);
      ctx.strokeStyle = dark ? '#F5EFE6' : '#241B12';
      ctx.lineWidth = Math.max(3, R * 0.045);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (pr * 0.30), cy + Math.sin(a) * (pr * 0.30));
      ctx.lineTo(cx + Math.cos(a) * (R + 1), cy + Math.sin(a) * (R + 1));
      ctx.stroke();

      // zpětná vazba po klepnutí
      if (S.flash && now < S.flashUntil) {
        const t = (S.flashUntil - now) / 420;
        ctx.globalAlpha = Math.max(0, t) * 0.9;
        ctx.fillStyle = S.flash === 'gold' ? '#EFA528' : S.flash === 'good' ? '#69A874' : '#D8402F';
        ctx.font = `700 ${Math.round(R * 0.26)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(S.flash === 'gold' ? 'PERFEKTNÍ' : S.flash === 'good' ? 'DOBRÉ' : 'SPÁLENO',
          cx, cy + pr + ringW * 0.1);
        ctx.globalAlpha = 1;
      }
    }

    /* — ukazatel právě běžících efektů —
       Časované (Máslo, Větší pánev) ukazují, kolik otoček ještě vydrží; jednorázové
       pojistky (Poklice, Zlatá palačinka) čekají, dokud je nespustí chyba. */
    function renderActive() {
      const chips = [];
      if (S.slowFlips > 0) chips.push({ p: POWERUPS.butter, left: S.slowFlips });
      if (S.wideFlips > 0) chips.push({ p: POWERUPS.bigpan, left: S.wideFlips });
      if (S.shield) chips.push({ p: POWERUPS.lid, left: null });
      if (S.keepStreak) chips.push({ p: POWERUPS.golden, left: null });
      // Od tří efektů výš se popisky vypouští — jinak by se ořízly na „M…"/„Po…".
      // Ikony jsou kreslené právě proto, aby samy o sobě stačily; název zůstává
      // v title a v aria-label kvůli čtečkám.
      const compact = chips.length >= 3;
      elActive.innerHTML = chips.map(c => `
        <span class="gm-chip" title="${escapeHtml(c.p.name)} — ${escapeHtml(c.p.desc)}"
              aria-label="${escapeHtml(c.p.name)}${c.left !== null ? `, zbývá ${c.left} otočky` : ', čeká na chybu'}">
          ${c.p.icon}
          ${compact ? '' : `<span class="gm-chip-name">${escapeHtml(c.p.name)}</span>`}
          ${c.left !== null
            ? `<span class="gm-chip-left">${c.left}×</span>`
            : `<span class="gm-chip-left is-armed">čeká</span>`}
        </span>`).join('');
    }

    /* — power-upy — */
    function renderSlots() {
      elSlots.innerHTML = [0, 1, 2].map(i => {
        const id = S.slots[i];
        if (!id) return `<div class="gm-slot is-empty" aria-hidden="true"></div>`;
        const p = POWERUPS[id];
        return `<button type="button" class="gm-slot" data-slot="${i}" title="${escapeHtml(p.desc)}" aria-label="${escapeHtml(p.name)} — ${escapeHtml(p.desc)}">
          <span class="gm-slot-glyph">${p.icon}</span><span class="gm-slot-name">${escapeHtml(p.name)}</span>
        </button>`;
      }).join('');
    }
    renderSlots();
    renderActive();

    // klepnutí na power-up NESMÍ zároveň otočit palačinku
    elSlots.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-slot]');
      if (!b) return;
      usePowerup(+b.dataset.slot);
    });

    function usePowerup(i) {
      const id = S.slots[i];
      if (!id || S.over) return;
      S.slots.splice(i, 1);
      if (id === 'butter') S.slowFlips = POWERUPS.butter.flips;
      if (id === 'bigpan') S.wideFlips = POWERUPS.bigpan.flips;
      if (id === 'lid') S.shield = true;
      if (id === 'golden') S.keepStreak = true;
      renderSlots();
      renderActive();
      updateHud();
      toast(POWERUPS[id].name + ' použito');
    }

    function grantPowerup() {
      if (S.slots.length >= 3) return null;
      const id = POWERUP_IDS[Math.floor(Math.random() * POWERUP_IDS.length)];
      S.slots.push(id);
      renderSlots();
      return id;
    }

    function updateHud() {
      elScore.textContent = S.score;
      elStreak.textContent = S.streak + (S.streak >= 5 ? ` ×${1 + Math.floor(S.streak / 5)}` : '');
      elLives.textContent = '●'.repeat(S.lives) + '○'.repeat(Math.max(0, 3 - S.lives));
      elLives.classList.toggle('is-shield', S.shield);
    }
    updateHud();

    /* — klepnutí = otočení palačinky — */
    function flip() {
      if (S.over) return;
      const now = performance.now();
      const zl = zoneLenNow(), gl = goldLenNow();
      const rel = norm(S.ang - S.zoneStart);
      const goldFrom = (zl - gl) / 2;
      const hitGold = rel >= goldFrom && rel <= goldFrom + gl;
      const hitGood = rel <= zl;

      if (hitGold || hitGood) {
        const mult = 1 + Math.floor(S.streak / 5);
        S.streak++;
        S.level++;
        S.score += (hitGold ? 25 : 10) * mult;
        S.flash = hitGold ? 'gold' : 'good';
        if (hitGold) {
          const got = grantPowerup();
          if (got) toast('Power-up: ' + POWERUPS[got].name);
        }
        if (S.slowFlips > 0) S.slowFlips--;
        if (S.wideFlips > 0) S.wideFlips--;
        elHint.hidden = true;
      } else if (S.shield) {
        S.shield = false;               // poklice smaže chybu i se sérií
        S.flash = 'good';
        toast('Poklice tě zachránila');
      } else {
        S.lives--;
        S.flash = 'miss';
        if (S.keepStreak) {             // zlatá palačinka zachrání jen sérii
          S.keepStreak = false;
          toast('Zlatá palačinka udržela sérii');
        } else {
          S.streak = 0;
        }
        if (S.lives <= 0) return gameOver();
      }
      S.flashUntil = now + 420;
      newZone();
      renderActive();
      updateHud();
    }

    const onDown = e => { e.preventDefault(); flip(); };
    stage.addEventListener('pointerdown', onDown);
    const onKey = e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); flip(); } };
    window.addEventListener('keydown', onKey);

    /* — smyčka — */
    let raf = 0;
    function loop(now) {
      const dt = Math.min((now - S.last) / 1000, 0.05);
      S.last = now;
      const sp = S.speed * (S.slowFlips > 0 ? 0.62 : 1);
      S.ang = norm(S.ang + S.dir * sp * dt);
      draw(now);
      raf = requestAnimationFrame(loop);
    }
    S.last = performance.now();
    raf = requestAnimationFrame(loop);

    function cleanup() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      stage.removeEventListener('pointerdown', onDown);
    }
    stopGame = cleanup;

    function gameOver() {
      S.over = true;
      cleanup();
      stopGame = null;
      const isRecord = saveHighScore(myName(), S.score);
      renderMenu(S.score, isRecord);
    }
  }

  renderMenu();
}

/* ================= Zpětná vazba ================= */
function openFeedback() {
  const sheet = openSheet({
    title: 'Zpětná vazba',
    bodyHtml: `
      <p class="muted" style="font-size:14px;margin:4px 0 14px">Našel jsi chybu, nebo máš nápad na vylepšení? Napiš, zpráva se odešle e-mailem vývojáři.</p>
      <div class="form-group">
        <label class="form-label">Kdo píše</label>
        <input class="form-input" id="fb-name" value="${escapeHtml(readOnly() ? '' : myName())}" placeholder="Tvoje jméno">
      </div>
      <div class="form-group">
        <label class="form-label">Zpráva</label>
        <textarea class="form-textarea" id="fb-text" style="min-height:110px" placeholder="Co nefunguje, nebo co by se ti hodilo?"></textarea>
      </div>
      <button class="btn btn-primary btn-block" id="fb-send">Odeslat e-mailem</button>`,
  });
  sheet.body.querySelector('#fb-send').addEventListener('click', () => {
    const name = sheet.body.querySelector('#fb-name').value.trim() || 'Anonym';
    const text = sheet.body.querySelector('#fb-text').value.trim();
    if (!text) { toast('Napiš text zprávy'); return; }
    const subject = encodeURIComponent('Kuchařka: zpětná vazba');
    const body = encodeURIComponent(`Od: ${name}\n\n${text}`);
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
    sheet.close();
  });
}

/* ================= Offline stav ================= */
function updateOnline() {
  document.getElementById('offline-banner').hidden = navigator.onLine;
}
window.addEventListener('online', () => { updateOnline(); toast('Zase online'); });
window.addEventListener('offline', updateOnline);
updateOnline();

/* ================= PWA ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ================= Přihlášení a zámek appky ================= */
function publicShareId() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  return a === 'recept' && b ? decodeURIComponent(b) : null;
}

const publicBannerEl = document.getElementById('public-banner');
function showGuestBanner(text, btnLabel) {
  publicBannerEl.querySelector('span').textContent = text;
  publicBannerEl.querySelector('#public-login-btn').textContent = btnLabel;
  publicBannerEl.hidden = false;
}
function hideGuestBanner() {
  publicBannerEl.hidden = true;
}

// Jediná výjimka ze zámku: cílený dotaz na JEDEN výslovně odemčený (r.shared === true)
// recept, ne plošné subscribe() na celou sbírku.
async function tryPublicRecipe(id) {
  try {
    const snap = await getDoc(doc(db, 'recipes', id));
    if (!snap.exists() || !snap.data().shared) return false;
    state.recipes = [{ ...snap.data(), id: snap.id }];
    state.loaded = true;
    publicMode = true;
    document.body.classList.add('public-view');
    showGuestBanner('Kuchařka je jinak zamčená', 'Zobrazit celou kuchařku');
    hideAuthGate();
    render();
    return true;
  } catch {
    return false;
  }
}

function exitPublicPreview() {
  publicMode = false;
  document.body.classList.remove('public-view');
  hideGuestBanner();
  showAuthGate('signin', { onGuest: startGuestMode });
}

// Host: prohlížení celé kuchařky (recepty jsou teď čitelné pro kohokoli), bez možnosti
// cokoli přidat/upravit/komentovat — pravidla Firestore/Storage zápisy stejně odmítnou.
// Pokud cloud ještě pravidla nemá nasazená, subscribe() to sám přepne na ukázková data
// (viz guestDemoFallback v recipes onSnapshot výše).
function startGuestMode() {
  guestMode = true;
  hideAuthGate();
  showGuestBanner('Prohlížíš jako host', 'Přihlásit se');
  renderProfileButtons();
  render();
  subscribe();
}

function exitGuestMode() {
  guestMode = false;
  guestDemoFallback = false;
  DEMO = URL_DEMO;
  hideGuestBanner();
  showAuthGate('signin', { onGuest: startGuestMode });
}
publicBannerEl.querySelector('#public-login-btn').addEventListener('click', () => {
  if (publicMode) exitPublicPreview();
  else if (guestMode || guestDemoFallback) exitGuestMode();
});

/* ================= Start ================= */
renderProfileButtons();
if (DEMO) {
  render();
  subscribe();
} else {
  let started = false;
  const shareId = publicShareId();
  watchAuthState(async user => {
    if (user && user.emailVerified && !currentDisplayName()) {
      // účet bez jména (např. selhalo updateProfile při registraci) — dopln ho před vstupem
      showAuthGate('need-name');
      return;
    }
    if (user && user.emailVerified) {
      publicMode = false;
      guestMode = false;
      guestDemoFallback = false;
      DEMO = URL_DEMO;
      document.body.classList.remove('public-view');
      hideGuestBanner();
      hideAuthGate();
      renderProfileButtons();
      if (!started) { started = true; render(); subscribe(); }
      return;
    }
    renderProfileButtons();
    if (publicMode || guestMode || guestDemoFallback) return;
    if (!started && shareId && await tryPublicRecipe(shareId)) return;
    showAuthGate(user ? 'verify-email' : 'signin', { onGuest: startGuestMode });
  });
}
