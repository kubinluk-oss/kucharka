// Přihlašovací brána (Firebase Auth): vykresluje #auth-gate a stará se o
// přihlášení/registraci/reset hesla. Kdo co vidí, určují skupiny (viz app.js).
import {
  auth,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, sendEmailVerification, updateProfile,
  reauthenticateWithCredential, EmailAuthProvider, updatePassword,
  setPersistence, browserLocalPersistence,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult
} from './firebase.js';
import { toast, alertDialog } from './ui.js';
import { escapeHtml } from './util.js';

const gate = document.getElementById('auth-gate');

/* Přihlášení se ukládá do prohlížeče natrvalo (browserLocalPersistence), takže
   po zavření a otevření appky zůstává člověk přihlášený. Nastavuje se hned při
   načtení modulu a `persistenceReady` je slib, na který se dá počkat — jinak by
   šlo kliknout na přihlášení dřív, než se nastavení stihne projevit. */
const persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ---------- Přihlášení přes Google ----------
   Aby tlačítko fungovalo, musí být Google POVOLENÝ ve Firebase konzoli
   (Authentication → Sign-in method) — je to zdarma, stačí ho zapnout a vybrat
   support e-mail. Když povolený není, Firebase vrátí `auth/operation-not-allowed`
   a uživatel dostane srozumitelnou hlášku (viz errMsg).
   Přihlášení přes Apple tu ZÁMĚRNĚ NENÍ: Firebase pro něj vyžaduje Service ID
   a klíč, a ty jdou vytvořit jen v platném Apple Developer Programu (~$99/rok). */

/* POZOR na volbu popup vs. přesměrování.
   Appka běží na jiné doméně (github.io) než `authDomain` Firebase projektu
   (…firebaseapp.com). Přihlášení PŘESMĚROVÁNÍM si musí mezi těmi doménami předat
   rozdělaný stav — a to Safari i další prohlížeče kvůli ochraně soukromí blokují.
   Přihlášení pak tiše zhasne: uživatel se vrátí na přihlašovací obrazovku a
   `getRedirectResult` vrátí null BEZ chyby, takže by se nedozvěděl vůbec nic.
   Proto zkoušíme NEJDŘÍV popup (ten chyby hlásí) a přesměrování necháváme jen
   jako nouzovku — a značkou v sessionStorage si pamatujeme, že běží, abychom
   poznali, že se nedokončilo, a řekli to uživateli.
   Trvale to vyřeší až provoz appky na stejné doméně jako authDomain. */
const REDIRECT_FLAG = 'kucharka-auth-redirect';
const flagSet = v => { try { v ? sessionStorage.setItem(REDIRECT_FLAG, '1') : sessionStorage.removeItem(REDIRECT_FLAG); } catch { /* soukromý režim */ } };
const flagGet = () => { try { return !!sessionStorage.getItem(REDIRECT_FLAG); } catch { return false; } };

async function signInWithGoogle() {
  await persistenceReady;   // ať se přihlášení určitě uloží natrvalo
  const provider = new GoogleAuthProvider();
  // vždy nabídnout výběr účtu, ať se na sdíleném zařízení nepřihlásí pod cizím
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await signInWithPopup(auth, provider);
  } catch (e) {
    // popup zablokovaný/nepodporovaný (in-app prohlížeče, appka na ploše) -> nouzovka
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment',
         'auth/cancelled-popup-request'].includes(e.code)) {
      flagSet(true);
      return signInWithRedirect(auth, provider);
    }
    throw e;
  }
}

// Návrat z přesměrování. Když jsme ho spustili, ale nevrátil uživatele ANI chybu,
// znamená to přesně tu tichou smrt popsanou výše — a musíme to říct nahlas.
getRedirectResult(auth)
  .then(res => {
    if (!flagGet()) return;
    flagSet(false);
    if (!res || !res.user) {
      alertDialog('Přihlášení se nedokončilo',
        'Prohlížeč kvůli ochraně soukromí zahodil rozdělané přihlášení přes Google. ' +
        'Zkus to prosím znovu, nebo se přihlas e-mailem a heslem, to funguje vždycky.');
    }
  })
  .catch(e => { flagSet(false); alertDialog('Přihlášení se nepovedlo', errMsg(e)); });

// Má uživatel heslo? (účet přes Google/Apple žádné nemá -> nedává smysl ho měnit)
export function hasPasswordProvider() {
  return !!auth.currentUser?.providerData?.some(p => p.providerId === 'password');
}

export function watchAuthState(cb) {
  return onAuthStateChanged(auth, cb);
}

export function hideAuthGate() {
  gate.hidden = true;
  gate.innerHTML = '';
}

function errMsg(e) {
  const map = {
    'auth/invalid-email': 'Neplatný formát e-mailu.',
    'auth/invalid-credential': 'Nesprávný e-mail nebo heslo.',
    'auth/wrong-password': 'Nesprávný e-mail nebo heslo.',
    'auth/user-not-found': 'Nesprávný e-mail nebo heslo.',
    'auth/email-already-in-use': 'S tímhle e-mailem už účet existuje. Zkus se rovnou přihlásit.',
    'auth/weak-password': 'Heslo musí mít alespoň 6 znaků.',
    'auth/too-many-requests': 'Příliš mnoho pokusů, zkus to za chvíli.',
    'auth/network-request-failed': 'Zkontroluj připojení k internetu.',
    // Google/Apple přihlášení
    'auth/popup-closed-by-user': 'Okno přihlášení bylo zavřeno.',
    'auth/user-cancelled': 'Přihlášení bylo zrušeno.',
    'auth/operation-not-allowed': 'Tenhle způsob přihlášení není zapnutý ve Firebase konzoli (Authentication → Sign-in method).',
    // Authentication ve Firebase projektu ještě nebylo vůbec zapnuté
    'auth/configuration-not-found': 'Přihlašování ještě není v Firebase zapnuté (Authentication → Get started). Zatím jde kuchařku prohlížet bez přihlášení.',
    'auth/unauthorized-domain': 'Tahle adresa není povolená ve Firebase (Authentication → Settings → Authorized domains).',
    'auth/account-exists-with-different-credential':
      'S tímhle e-mailem už účet existuje, jen byl vytvořen jinak. Přihlas se původním způsobem (e-mailem a heslem).',
  };
  return map[e.code] || 'Něco se nepovedlo. Zkus to znovu.';
}

// Logo Google v předepsaných barvách (brand guidelines).
const googleLogoSvg = `<svg viewBox="0 0 18 18" width="19" height="19" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H1.01v2.34A8.99 8.99 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H1.01a9 9 0 0 0 0 8.12l2.96-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A8.99 8.99 0 0 0 1.01 4.94l2.96 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>`;

// Tlačítko „Přihlásit se přes Google" + oddělovač od e-mailového formuláře.
function oauthButtonsHtml() {
  return `<div class="oauth-row">
      <button class="btn btn-block oauth-btn" id="auth-google">${googleLogoSvg}<span>Přihlásit se přes Google</span></button>
    </div>
    <div class="auth-or"><span>nebo e-mailem</span></div>`;
}

// Zapojí tlačítko Google, pokud je v aktuálním obsahu brány.
function wireOauthButtons() {
  const btn = gate.querySelector('#auth-google');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    gate.querySelectorAll('.oauth-btn').forEach(b => b.disabled = true);
    try {
      await signInWithGoogle();
      // úspěch: dál pokračuje watchAuthState (případně přes doplnění jména)
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request')
        alertDialog('Přihlášení se nepovedlo', errMsg(e));
    } finally {
      gate.querySelectorAll('.oauth-btn').forEach(b => b.disabled = false);
    }
  });
}

let guestCallback = null;

export function showAuthGate(mode = 'signin', { onGuest = null } = {}) {
  gate.hidden = false;
  guestCallback = onGuest;
  if (mode === 'signin' || mode === 'signup' || mode === 'reset') renderForm(mode);
  else if (mode === 'verify-email') renderVerify();
  else if (mode === 'need-name') renderNeedName();
}

function renderForm(mode) {
  const isSignup = mode === 'signup';
  const isReset = mode === 'reset';
  gate.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand">Kuchařka<span>.</span></div>
        ${isReset ? `
          <p class="auth-lead">Zadej e-mail, na který ti pošleme odkaz pro obnovení hesla.</p>
          <div class="form-group">
            <label class="form-label">E-mail</label>
            <input class="form-input" type="email" id="auth-email" autocomplete="email">
          </div>
          <button class="btn btn-primary btn-block" id="auth-submit">Odeslat odkaz</button>
          <button class="link-btn auth-switch" id="auth-back">Zpět na přihlášení</button>
        ` : `
          <div class="auth-tabs">
            <button class="${!isSignup ? 'active' : ''}" data-auth-tab="signin">Přihlásit</button>
            <button class="${isSignup ? 'active' : ''}" data-auth-tab="signup">Registrovat</button>
          </div>
          ${oauthButtonsHtml()}
          ${isSignup ? `
          <div class="form-group">
            <label class="form-label">Jméno</label>
            <input class="form-input" type="text" id="auth-name" autocomplete="name" maxlength="40" placeholder="Jak se ti říká">
          </div>` : ''}
          <div class="form-group">
            <label class="form-label">E-mail</label>
            <input class="form-input" type="email" id="auth-email" autocomplete="${isSignup ? 'email' : 'username'}">
          </div>
          <div class="form-group">
            <label class="form-label">Heslo</label>
            <input class="form-input" type="password" id="auth-password" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
          </div>
          <button class="btn btn-primary btn-block" id="auth-submit">${isSignup ? 'Vytvořit účet' : 'Přihlásit se'}</button>
          ${!isSignup ? '<button class="link-btn auth-switch" id="auth-forgot">Zapomenuté heslo?</button>' : ''}
          ${guestCallback ? '<button class="link-btn auth-switch" id="auth-guest">Prohlížet bez přihlášení</button>' : ''}
        `}
      </div>
    </div>`;

  wireOauthButtons();
  gate.querySelectorAll('[data-auth-tab]').forEach(b =>
    b.addEventListener('click', () => renderForm(b.dataset.authTab)));
  gate.querySelector('#auth-back')?.addEventListener('click', () => renderForm('signin'));
  gate.querySelector('#auth-forgot')?.addEventListener('click', () => renderForm('reset'));
  gate.querySelector('#auth-guest')?.addEventListener('click', () => guestCallback && guestCallback());

  const submit = gate.querySelector('#auth-submit');
  const emailEl = gate.querySelector('#auth-email');
  const pwEl = gate.querySelector('#auth-password');
  const nameEl = gate.querySelector('#auth-name');

  submit.addEventListener('click', async () => {
    const email = (emailEl.value || '').trim().toLowerCase();
    if (!email) { emailEl.focus(); return; }

    if (isReset) {
      submit.disabled = true;
      try {
        await sendPasswordResetEmail(auth, email);
        toast('Odkaz na obnovení hesla byl odeslán');
        renderForm('signin');
      } catch (e) {
        alertDialog('Nepovedlo se', errMsg(e));
      } finally {
        submit.disabled = false;
      }
      return;
    }

    const password = pwEl.value || '';
    if (!password) { pwEl.focus(); return; }

    submit.disabled = true;
    try {
      if (isSignup) {
        const name = (nameEl.value || '').trim();
        if (!name) { nameEl.focus(); submit.disabled = false; return; }
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName: name });
        await sendEmailVerification(cred.user);
        renderVerify();
      } else {
        await persistenceReady;
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (e) {
      alertDialog('Nepovedlo se', errMsg(e));
    } finally {
      submit.disabled = false;
    }
  });
}

function renderVerify() {
  const email = auth.currentUser?.email || '';
  gate.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand">Kuchařka<span>.</span></div>
        <h2 class="auth-title">Potvrď e-mail</h2>
        <p class="auth-lead">Poslali jsme ověřovací odkaz na <b>${escapeHtml(email)}</b>. Otevři ho a pak se appka sama odemkne.</p>
        <button class="btn btn-primary btn-block" id="auth-recheck">Už jsem potvrdil/a</button>
        <button class="link-btn auth-switch" id="auth-resend">Poslat znovu</button>
        <button class="link-btn auth-switch" id="auth-signout">Odhlásit se</button>
      </div>
    </div>`;
  gate.querySelector('#auth-recheck').addEventListener('click', async () => {
    try { await auth.currentUser.reload(); } catch { /* ignore */ }
    if (auth.currentUser?.emailVerified) location.reload();
    else toast('E-mail ještě není potvrzený');
  });
  gate.querySelector('#auth-resend').addEventListener('click', async () => {
    try { await sendEmailVerification(auth.currentUser); toast('Odesláno znovu'); }
    catch (e) { alertDialog('Nepovedlo se', errMsg(e)); }
  });
  gate.querySelector('#auth-signout').addEventListener('click', () => signOut(auth));
}

/* Pojistka pro účet bez jména. Bez `displayName` by recepty a hodnocení neměly
   autora (myName() by vracelo prázdno), takže si jméno vyžádáme, než pustíme
   appku dál. Nastat to může, když při registraci selže updateProfile, nebo když
   externí poskytovatel jméno nepošle. */
function renderNeedName() {
  gate.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand">Kuchařka<span>.</span></div>
        <h2 class="auth-title">Jak se ti má říkat?</h2>
        <p class="auth-lead">Tímhle jménem se budou podepisovat tvoje recepty a hodnocení. Změnit ho můžeš kdykoli v nastavení.</p>
        <div class="form-group">
          <input class="form-input" type="text" id="auth-name" autocomplete="name" maxlength="40" placeholder="Třeba Lukáš">
        </div>
        <button class="btn btn-primary btn-block" id="auth-name-save">Pokračovat</button>
        <button class="link-btn auth-switch" id="auth-signout">Odhlásit se</button>
      </div>
    </div>`;
  const input = gate.querySelector('#auth-name');
  const save = gate.querySelector('#auth-name-save');
  setTimeout(() => input.focus(), 80);
  const submit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    save.disabled = true;
    try {
      await updateProfile(auth.currentUser, { displayName: name });
      location.reload();   // ať se appka rozjede s hotovým profilem
    } catch (e) {
      alertDialog('Nepovedlo se', errMsg(e));
      save.disabled = false;
    }
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  gate.querySelector('#auth-signout').addEventListener('click', () => signOut(auth));
}

export function signOutUser() {
  return signOut(auth);
}

export function currentDisplayName() {
  return auth.currentUser?.displayName || '';
}

export function currentUid() {
  return auth.currentUser?.uid || '';
}

export async function changeDisplayName(name) {
  await updateProfile(auth.currentUser, { displayName: name });
}

export async function changePassword(currentPassword, newPassword) {
  const cred = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
  await reauthenticateWithCredential(auth.currentUser, cred);
  await updatePassword(auth.currentUser, newPassword);
}
