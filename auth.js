/* ============================================================
   SUPABASE AUTH + CLOUD LISTS — auth.js
   Loaded after supabase-init.js, before app.js.

   WHERE THINGS ARE:
   • Supabase init       → supabase-init.js  (window.db, window.supabaseReady)
   • Google button click → initAuthModal()   (line ~80)  → signInWithGoogle()
   • OAuth callback      → initAuth()         (line ~30)  → handleAuthCallback()
   ============================================================ */

/* ── Shared auth state (read by app.js) ── */
const authState = {
  user:    null,
  session: null,
  lists:   [],
};

/* ──────────────────────────────────────────────────────────
   1. INIT  — called from app.js DOMContentLoaded
   ────────────────────────────────────────────────────────── */
async function initAuth() {
  // Wait for /api/config fetch + supabase.createClient() to finish
  if (window.supabaseReady) await window.supabaseReady;

  if (!window.db) {
    console.warn('[auth] ✗ Supabase not available — is SUPABASE_ANON_KEY set in Vercel?');
    updateAuthUI();
    return;
  }

  // ── 2. Handle OAuth callback ──────────────────────────────
  // With implicit flow, Supabase puts tokens in the URL hash.
  // detectSessionInUrl:true means the client picks them up automatically;
  // getSession() reads them out and stores them in localStorage.
  await handleAuthCallback();

  // ── 3. Restore session from localStorage ─────────────────
  const { data: { session }, error: sessionErr } = await window.db.auth.getSession();
  if (sessionErr) console.error('[auth] getSession error:', sessionErr);

  console.log('[auth] Session on load:', session);

  authState.session = session;
  authState.user    = session?.user ?? null;
  updateAuthUI();
  if (authState.user) await loadCloudLists();

  // ── 4. Keep UI in sync with future auth events ────────────
  window.db.auth.onAuthStateChange(async (_event, session) => {
    console.log('[auth] onAuthStateChange →', _event, session?.user?.email ?? 'no user');
    authState.session = session;
    authState.user    = session?.user ?? null;
    updateAuthUI();
    if (authState.user) {
      await loadCloudLists();
    } else {
      authState.lists = [];
      if (typeof populateSavedListsDropdown === 'function') populateSavedListsDropdown();
    }
  });
}

/* ── OAuth callback handler ─────────────────────────────────
   After Google redirects back, the URL contains the token in the hash.
   Supabase's detectSessionInUrl:true processes it automatically.
   We just need to call getSession() (done above) and clean the URL.
   ─────────────────────────────────────────────────────────── */
async function handleAuthCallback() {
  const hash   = window.location.hash;
  const search = window.location.search;

  const hasToken = hash.includes('access_token') || hash.includes('error_description');
  const hasCode  = search.includes('code=');

  if (!hasToken && !hasCode) return;  // nothing to handle

  console.log('[auth] OAuth callback detected in URL');

  // Supabase v2 with detectSessionInUrl:true handles the token/code automatically.
  // Just make sure the URL is cleaned up so it doesn't linger.
  try {
    const { data: { session }, error } = await window.db.auth.getSession();
    if (error) {
      console.error('[auth] Callback session error:', error);
      _showAuthToast('Error al iniciar sesión: ' + error.message, 'err');
    } else if (session) {
      console.log('[auth] ✓ Session from callback:', session.user.email);
    }
  } catch (e) {
    console.error('[auth] handleAuthCallback exception:', e);
  }

  // Clean up URL so tokens don't stay in browser history
  const cleanUrl = window.location.pathname + (hasCode ? '' : window.location.search);
  history.replaceState(null, '', cleanUrl);
}

/* ──────────────────────────────────────────────────────────
   2. AUTH STATUS BAR  (top of setup screen)
   ────────────────────────────────────────────────────────── */
function updateAuthUI() {
  const bar = document.getElementById('auth-bar');
  if (!bar) return;

  if (authState.user) {
    const display = authState.user.email
      || authState.user.user_metadata?.full_name
      || 'Usuario';
    bar.innerHTML = `
      <span class="auth-bar-status online"></span>
      <span class="auth-bar-email" title="${display}">${display}</span>
      <button class="auth-bar-btn" id="btn-signout">Cerrar sesión</button>
    `;
    document.getElementById('btn-signout')?.addEventListener('click', signOut);
    document.getElementById('cloud-save-banner')?.classList.add('hidden');
    hideAuthModal();
  } else {
    bar.innerHTML = `
      <span class="auth-bar-hint">Inicia sesión para guardar listas en la nube</span>
      <button class="auth-bar-btn" id="btn-signin-bar">Iniciar sesión</button>
    `;
    document.getElementById('btn-signin-bar')?.addEventListener('click', showAuthModal);
    document.getElementById('cloud-save-banner')?.classList.remove('hidden');
  }
}

/* ──────────────────────────────────────────────────────────
   3. AUTH ACTIONS
   ────────────────────────────────────────────────────────── */

/* ── GOOGLE OAUTH ────────────────────────────────────────── */
async function signInWithGoogle() {
  console.log('[auth] Google login click');

  // Make sure Supabase is ready
  if (window.supabaseReady) await window.supabaseReady;

  if (!window.db) {
    console.error('[auth] ✗ Supabase not initialised — check SUPABASE_ANON_KEY in Vercel');
    _showAuthToast('Error: Supabase no está configurado', 'err');
    return;
  }

  // Use location.origin so it works on both impostor.click and www.impostor.click
  const redirectTo = `${location.origin}/auth/callback`;
  console.log('[auth] Redirecting to OAuth… redirectTo =', redirectTo);

  const { error } = await window.db.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo },
  });

  if (error) {
    console.error('[auth] signInWithOAuth error:', error);
    _showAuthToast('Error al conectar con Google: ' + error.message, 'err');
  }
  // On success the browser is redirected — no further code runs here
}

/* ── EMAIL / PASSWORD ────────────────────────────────────── */
async function signInWithEmail(email, password) {
  if (window.supabaseReady) await window.supabaseReady;
  if (!window.db) return new Error('Supabase not configured');
  const { error } = await window.db.auth.signInWithPassword({ email, password });
  return error ?? null;
}

async function signUpWithEmail(email, password) {
  if (window.supabaseReady) await window.supabaseReady;
  if (!window.db) return new Error('Supabase not configured');
  const { data, error } = await window.db.auth.signUp({ email, password });
  if (error) return error;
  if (!data.session) return { confirmEmail: true };
  return null;
}

async function signOut() {
  if (!window.db) return;
  await window.db.auth.signOut();
}

/* ──────────────────────────────────────────────────────────
   4. AUTH MODAL
   ────────────────────────────────────────────────────────── */
function showAuthModal() {
  document.getElementById('auth-modal')?.classList.remove('hidden');
}

function hideAuthModal() {
  document.getElementById('auth-modal')?.classList.add('hidden');
  _resetAuthForm();
}

function _resetAuthForm() {
  ['auth-email', 'auth-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('auth-error')?.classList.add('hidden');
  document.getElementById('auth-info')?.classList.add('hidden');
}

/* ── initAuthModal: attach all event listeners once ─────── */
function initAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;

  let isRegister = false;

  // ── Close button & backdrop click ────
  document.getElementById('btn-auth-close')?.addEventListener('click', hideAuthModal);
  modal.addEventListener('click', e => {
    if (e.target === modal) hideAuthModal();
  });

  // ── Google OAuth button ───────────────
  // This is the canonical event listener for #btn-auth-google
  const googleBtn = document.getElementById('btn-auth-google');
  if (googleBtn) {
    googleBtn.addEventListener('click', (e) => {
      e.stopPropagation();   // don't bubble to modal backdrop listener
      signInWithGoogle();
    });
    console.log('[auth] ✓ Google button listener attached to #btn-auth-google');
  } else {
    console.error('[auth] ✗ #btn-auth-google not found in DOM');
  }

  // ── Register / login toggle (delegated) ──
  modal.addEventListener('click', e => {
    if (e.target.id !== 'auth-toggle-link') return;
    isRegister = !isRegister;
    _setAuthMode(isRegister);
  });

  // ── Email/password form ───────────────
  document.getElementById('auth-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const btn      = document.getElementById('btn-auth-submit');
    const errEl    = document.getElementById('auth-error');
    const infoEl   = document.getElementById('auth-info');
    if (!email || !password) return;

    btn.disabled    = true;
    btn.textContent = '…';
    errEl.classList.add('hidden');
    infoEl.classList.add('hidden');

    let result;
    if (isRegister) {
      result = await signUpWithEmail(email, password);
      if (result?.confirmEmail) {
        infoEl.textContent = '¡Revisa tu email para confirmar tu cuenta!';
        infoEl.classList.remove('hidden');
        btn.disabled    = false;
        btn.textContent = 'Crear cuenta';
        return;
      }
    } else {
      result = await signInWithEmail(email, password);
    }

    if (result) {
      errEl.textContent = _translateAuthError(result.message || String(result));
      errEl.classList.remove('hidden');
      btn.disabled    = false;
      btn.textContent = isRegister ? 'Crear cuenta' : 'Entrar';
    } else {
      hideAuthModal();
    }
  });

  // ── Cloud-save banner shortcut ────────
  document.getElementById('btn-cloud-login')?.addEventListener('click', showAuthModal);
}

function _setAuthMode(register) {
  const el = id => document.getElementById(id);
  if (el('auth-modal-title')) el('auth-modal-title').textContent = register ? 'Crear cuenta' : 'Inicia sesión';
  if (el('btn-auth-submit'))  el('btn-auth-submit').textContent  = register ? 'Crear cuenta' : 'Entrar';
  if (el('auth-toggle-text')) el('auth-toggle-text').innerHTML   = register
    ? '¿Ya tienes cuenta? <a id="auth-toggle-link">Iniciar sesión</a>'
    : '¿No tienes cuenta? <a id="auth-toggle-link">Registrarse</a>';
}

function _translateAuthError(msg) {
  if (!msg) return 'Error desconocido.';
  if (msg.includes('Invalid login credentials')) return 'Email o contraseña incorrectos.';
  if (msg.includes('already registered'))        return 'Este email ya tiene cuenta. Inicia sesión.';
  if (msg.includes('Password should'))           return 'La contraseña debe tener al menos 6 caracteres.';
  if (msg.includes('Unable to validate'))        return 'Email o contraseña incorrectos.';
  if (msg.includes('Email not confirmed'))       return 'Confirma tu email primero. Revisa tu bandeja de entrada.';
  return msg;
}

function _showAuthToast(msg, type /* 'ok' | 'err' */) {
  let toast = document.getElementById('auth-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id        = 'auth-toast';
    toast.className = 'premium-toast';   // reuse the existing toast style
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'err'
    ? 'linear-gradient(135deg,#7f0000,#b71c1c)'
    : 'linear-gradient(135deg,#1b5e20,#2e7d32)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 5000);
}

/* ──────────────────────────────────────────────────────────
   5. CLOUD LISTS CRUD
   ────────────────────────────────────────────────────────── */
async function loadCloudLists() {
  if (!window.db || !authState.user) return;
  const { data, error } = await window.db
    .from('custom_lists')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) { console.error('[lists] loadCloudLists:', error); return; }
  authState.lists = data || [];
  console.log('[lists] loaded', authState.lists.length, 'cloud lists');
  if (typeof populateSavedListsDropdown === 'function') populateSavedListsDropdown();
}

async function saveCloudList(name, words) {
  if (!window.db || !authState.user) return false;
  const existing = authState.lists.find(l => l.name === name);
  let error;
  if (existing) {
    ({ error } = await window.db
      .from('custom_lists')
      .update({ words })
      .eq('id', existing.id)
      .eq('user_id', authState.user.id));
  } else {
    ({ error } = await window.db.from('custom_lists').insert({
      user_id: authState.user.id,
      name,
      words,
    }));
  }
  if (error) { console.error('[lists] saveCloudList:', error); return false; }
  await loadCloudLists();
  return true;
}

async function deleteCloudList(id) {
  if (!window.db || !authState.user) return;
  const { error } = await window.db
    .from('custom_lists')
    .delete()
    .eq('id', id)
    .eq('user_id', authState.user.id);
  if (error) { console.error('[lists] deleteCloudList:', error); return; }
  await loadCloudLists();
}
