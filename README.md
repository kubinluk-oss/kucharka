# Kuchařka — sdílená sbírka receptů

Webová aplikace běžící celá v prohlížeči, bez vlastního serveru. Data (recepty, kategorie, profily) žijí ve Firestore, fotky ve Firebase Storage — projekt `kucharka-c4a3f`. **Používá stejnou databázi jako původní verze aplikace**, takže obě verze vidí tytéž recepty.

## Design a navigace

Aplikace má magazínový (editorial) vzhled — serifové titulky, teplá krémová paleta, gradientové dlaždice — a navigaci jako nativní iOS appka: na mobilu plovoucí tab bar (Domů · Kategorie · ＋ · Nákup · Hledat), na desktopu horní lišta. Nastavení a profil jsou schované pod profilovou bublinkou (avatar s monogramem) vpravo nahoře, jako to dělá Apple. Každá obrazovka je samostatná stránka s vlastní adresou (hash routing, `#/recept/<id>`, `#/nakup`, `#/kategorie`, …), takže funguje tlačítko zpět v prohlížeči i gesto zpět na iPhonu.

## Nákupní seznam

Osobní (per-účet) seznam na `#/nakup`. Položky si člověk může psát ručně, nebo je hodit z receptu tlačítkem „Do nákupního seznamu" (přepočtené na zvolený počet porcí). Seznam se řadí podle kategorií v obchodě (maso k masu, mléčné k mléčným…) — třídění dělá `classifyIngredient` v `js/util.js` proti slovníku kmenů (bez ohledu na diakritiku/skloňování). Co se nepodaří zařadit, spadne do „Ostatní" a dá se přetáhnout úchytem do správné sekce. Ukládá se do Firestore `shoppingLists/{uid}` (přihlášený), nebo do `localStorage` (host / ukázkový režim).

## Struktura

```
index.html            – kostra aplikace (topnav, tab bar, PWA meta)
css/style.css         – vzhled (světlý/tmavý režim přes CSS proměnné)
js/app.js             – stav, synchronizace, hash router a všechny stránky
js/firebase.js        – konfigurace a inicializace Firebase (Firestore, Storage, Auth)
js/auth.js            – přihlašovací brána, správa hesla a seznamu povolených e-mailů
js/ui.js              – sheety, dialogy, toasty, loader, výběr hvězdiček
js/util.js            – čisté pomocné funkce (přepočty, hledání, komprese fotek)
sw.js                 – service worker (cache souborů aplikace)
manifest.webmanifest  – PWA manifest (instalace na plochu)
icons/                – ikony aplikace
```

## Nasazení

Stačí nahrát celou složku na libovolný statický hosting (Cloudflare Pages, Firebase Hosting, GitHub Pages…). Není potřeba žádný build.

Musí se servírovat přes **HTTPS** (kvůli service workeru, sdílení a schránce) — všechny zmíněné hostingy to dělají automaticky.

## 🔒 Přihlašování a bezpečnostní pravidla Firebase

Přidávat, upravovat, mazat a komentovat recepty jde jen po přihlášení (Firebase Authentication, e-mail + heslo) a jen tomu, koho někdo uvnitř appky pozve (Nastavení → „Kdo má přístup"). Heslo, které si kdokoli zvolí, je hashované na straně Google a majitel projektu ho nikde nevidí — v konzoli i v appce je vidět jen e-mail a interní ID účtu. Zapomenuté heslo se řeší samoobslužně (odkaz „Zapomenuté heslo?" na přihlašovací obrazovce), stejně tak změna hesla v Nastavení.

**Prohlížení je otevřené i bez účtu** — na přihlašovací obrazovce je odkaz „Prohlížet bez přihlášení", který pustí dovnitř na čtení (recepty, kategorie, hodnocení), ale bez možnosti cokoli přidat, upravit nebo okomentovat — tlačítka pro úpravy se v tomhle režimu vůbec nezobrazí a i kdyby někdo zápis vynutil mimo appku, pravidla níže ho odmítnou. Navíc jde u jednotlivého receptu v jeho detailu zapnout „Sdílet" — kdokoli s tím konkrétním odkazem dostane rovnou minimalistický náhled jen toho receptu, bez zbytku navigace.

### Jednorázové nastavení v [konzoli Firebase](https://console.firebase.google.com/project/kucharka-c4a3f)

1. **Authentication → Sign-in method** → zapnout **E-mail/heslo**.
2. Než nasadíš pravidla níže (dokud jsou ještě otevřená z minula), založ si vlastní účet přímo v appce (registrace) a potvrď si e-mail z došlé zprávy.
3. **Firestore Database → Data** → ručně vytvoř dokument `meta/allowedEmails` s polem `list` typu pole obsahujícím tvůj e-mail malými písmeny, např. `["muj@email.cz"]`.
4. Níže do pravidel doplň svůj e-mail místo `OWNER_EMAIL_ZDE` (pojistka, kdyby se dokument s povolenými e-maily někdy poškodil) a nasaď obě sady pravidel.
5. Od teď se další lidé přidávají už jen z appky (Nastavení → „Kdo má přístup") — žádné další zásahy v konzoli nejsou potřeba.

**Firestore Database → Rules**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isOwner() {
      return request.auth != null &&
        request.auth.token.email_verified == true &&
        request.auth.token.email.lower() == 'OWNER_EMAIL_ZDE';
    }
    function isAllowed() {
      return isOwner() ||
        (request.auth != null &&
         request.auth.token.email_verified == true &&
         request.auth.token.email.lower() in
           get(/databases/$(database)/documents/meta/allowedEmails).data.list);
    }

    match /recipes/{recipe} {
      allow read: if true;
      allow write: if isAllowed();
    }
    match /meta/allowedEmails {
      allow read, write: if isAllowed();
    }
    match /meta/{doc} {
      allow read: if true;
      allow write: if isAllowed();
    }
    // Osobní nákupní seznam — každý čte i píše jen ten svůj.
    match /shoppingLists/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

**Storage → Rules**:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /photos/{photo} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email_verified == true &&
          request.auth.token.email.lower() in firestore.get(/databases/(default)/documents/meta/allowedEmails).data.list;
    }
  }
}
```

Recepty, kategorie a fotky jsou tedy čitelné pro kohokoli se znalostí adresy (host i sdílený recept) — psát smí jen pozvaní. Zápisové Storage pravidlo používá cross-service dotaz do Firestore (`firestore.get(...)`); při prvním nasazení tě konzole požádá o jednorázové schválení tohoto oprávnění — normální krok, pořád zdarma (Spark plán), pořád bez vlastního backendu.

## Demo režim

Otevři aplikaci s `?demo=1` (např. `https://…/index.html?demo=1`) a poběží s ukázkovými recepty jen v paměti — nic se nečte ani nezapisuje do cloudu, přihlašovací brána se přeskočí. Hodí se na vyzkoušení.

## Úpravy

- **E-mail pro zpětnou vazbu**: konstanta `FEEDBACK_EMAIL` na začátku `js/app.js`.
- **Firebase projekt**: `js/firebase.js`.
- **Výchozí kategorie a jednotky**: `js/util.js` (`DEFAULT_CATS`, `UNITS`).
- Po změně souborů zvyš verzi cache v `sw.js` (`kucharka-v1` → `v2`…), ať se změny hned propíšou i do nainstalované aplikace.
