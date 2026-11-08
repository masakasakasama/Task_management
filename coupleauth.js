// Google sign-in limited to the two of us. The Firestore rules enforce the same
// allow-list server-side; this module only drives the UI.
//
// Usage: coupleAuth(authApi, auth, { id, label, onReady });
// `authApi` is the firebase-auth module of the same SDK version as `auth`.

export const ALLOWED_EMAILS = ["masakasakasama.man@gmail.com", "rere.geier@gmail.com"];

export function isAllowedUser(user) {
  return Boolean(user && user.email && ALLOWED_EMAILS.includes(user.email.toLowerCase()));
}

export function coupleAuth(authApi, auth, { id, label, onReady }) {
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } = authApi;
  let ready = false;

  function banner(message) {
    let el = document.getElementById(`auth-banner-${id}`);
    if (!el) {
      el = document.createElement("div");
      el.id = `auth-banner-${id}`;
      el.className = "sync-error-banner";
      // Inline styles so the banner looks the same in apps without this class.
      // Stack above any other sign-in banner already on screen.
      const offset = 12 + 110 * document.querySelectorAll("[id^='auth-banner-']").length;
      el.style.cssText = `position:fixed;left:12px;right:12px;bottom:${offset}px;z-index:10000;` +
        "padding:12px 14px;border-radius:14px;background:rgba(30,30,40,.92);color:#fff;font-size:14px;line-height:1.5;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.25);text-align:center";
      el.innerHTML = `<span class="auth-msg"></span><br>` +
        `<button class="sync-error-action" style="margin-top:8px;padding:8px 14px;border:0;border-radius:10px;background:#fff;color:#222;font-weight:600">Googleでログイン</button> ` +
        `<button class="sync-error-close" style="margin-top:8px;padding:8px 14px;border:1px solid rgba(255,255,255,.5);border-radius:10px;background:transparent;color:#fff">あとで</button>`;
      document.body.appendChild(el);
      el.querySelector(".sync-error-action").onclick = () => signIn();
      el.querySelector(".sync-error-close").onclick = () => el.remove();
    }
    el.querySelector(".auth-msg").textContent = message;
  }

  function hideBanner() {
    const el = document.getElementById(`auth-banner-${id}`);
    if (el) el.remove();
  }

  async function signIn() {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      const code = err && err.code;
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
        return signInWithRedirect(auth, provider);
      }
      banner(`ログインできませんでした (${code || err})`);
    }
  }

  onAuthStateChanged(auth, (user) => {
    if (isAllowedUser(user)) {
      hideBanner();
      if (!ready) { ready = true; onReady && onReady(user); }
      return;
    }
    ready = false;
    if (user) {
      signOut(auth);
      banner(`${user.email} は使えません。許可されたアカウントでログインしてください`);
      return;
    }
    banner(label);
  });

  return { signIn, isReady: () => ready, prompt: () => banner(label) };
}
