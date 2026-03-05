/* ============================================================
   SUPABASE AUTH + CLOUD LISTS — auth.js
   Loaded after supabase-init.js, before app.js
   ============================================================ */

/* ── Shared auth state (read by app.js) ── */
const authState = {
  user:    null,
  session: null,
  lists:   [],   // [{id, user_id, name, words, created_at}] from custom_lists
};

/* ──────────────────────────────────────────────────────────
   INIT — call once inside DOMContentLoaded
   ────────────────────────────────────────────────────────── */
async function initAuth() {
  // Wait for supabase-init.js to finish its async fetch
  if (window.supabaseReady) await window.supabaseReady;

  if (!window.db) {
    console.warn('[auth] Supabase not available — auth disabled');
    updateAuthUI();
    return;
  }

  // Restore session from storage or OAuth hash
  const { data: { session }, error: sessionError } = await window.db.auth.getSession();
  if (sessionError) console.error('[auth] getSession error:', sessionError);
  authState.session = session;
  authState.user    = session?.user ?? null;
  updateAuthUI();
  if (authState.user) await loadCloudLists();

  // Keep in sync with future auth events (login, logout, token refresh)
  window.db.auth.onAuthStateChange(async (_event, session) => {
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

/* ──────────────────────────────────────────────────────────
   AUTH STATUS BAR  (top of setup screen)
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
    // Hide cloud-save nudge inside panel-write
    document.getElementById('cloud-save-banner')?.classList.add('hidden');
  } else {
    bar.innerHTML = `
      <span class="auth-bar-hint">Inicia sesión para guardar listas en la nube</span>
      <button class="auth-bar-btn" id="btn-signin-bar">Iniciar sesión</button>
    `;
    document.getElementById('btn-signin-bar')?.addEventListener('click', showAuthModal);
    // Show cloud-save nudge
    document.getElementById('cloud-save-banner')?.classList.remove('hidden');
  }
}

/* ──────────────────────────────────────────────────────────
   AUTH ACTIONS
   ────────────────────────────────────────────────────────── */
async function signInWithGoogle() {
  if (window.supabaseReady) await window.supabaseReady;
  if (!window.db) {
    console.error('[auth] signInWithGoogle: Supabase client not initialised');
    return;
  }
  console.log('[auth] starting Google OAuth redirect…');
  const { error } = await window.db.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: 'https://www.impostor.click' },
  });
  if (error) console.error('[auth] signInWithOAuth error:', error);
}

/** Returns null on success, Error object on failure */
async function signInWithEmail(email, password) {
  if (window.supabaseReady) await window.supabaseReady;
  if (!window.db) return new Error('Supabase not configured');
  const { error } = await window.db.auth.signInWithPassword({ email, password });
  return error ?? null;
}

/** Returns null on success, { confirmEmail: true } when confirmation email sent, or Error */
async function signUpWithEmail(email, password) {
  if (window.supabaseReady) await window.supabaseReady;
  if (!window.db) return new Error('Supabase not configured');
  const { data, error } = await window.db.auth.signUp({ email, password });
  if (error) return error;
  // If no session, email confirmation is required
  if (!data.session) return { confirmEmail: true };
  return null;
}

async function signOut() {
  if (!window.db) return;
  await window.db.auth.signOut();
}

/* ──────────────────────────────────────────────────────────
   AUTH MODAL
   ────────────────────────────────────────────────────────── */
function showAuthModal() {
  document.getElementById('auth-modal')?.classList.remove('hidden');
}

function hideAuthModal() {
  document.getElementById('auth-modal')?.classList.add('hidden');
  _resetAuthForm();
}

function _resetAuthForm() {
  const el = id => document.getElementById(id);
  if (el('auth-email'))    el('auth-email').value    = '';
  if (el('auth-password')) el('auth-password').value = '';
  if (el('auth-error'))    el('auth-error').classList.add('hidden');
  if (el('auth-info'))     el('auth-info').classList.add('hidden');
}

function initAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (!modal) return;

  let isRegister = false;

  // Close on X or backdrop click
  document.getElementById('btn-auth-close')?.addEventListener('click', hideAuthModal);
  modal.addEventListener('click', e => {
    if (e.target === modal) hideAuthModal();
  });

  // Google OAuth
  document.getElementById('btn-auth-google')?.addEventListener('click', signInWithGoogle);

  // Register / login mode toggle — delegated so it survives innerHTML changes
  modal.addEventListener('click', e => {
    if (e.target.id !== 'auth-toggle-link') return;
    isRegister = !isRegister;
    _setAuthMode(isRegister);
  });

  // Form submit
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

  // Cloud-save banner "Iniciar sesión" shortcut
  document.getElementById('btn-cloud-login')?.addEventListener('click', showAuthModal);
}

function _setAuthMode(register) {
  const titleEl  = document.getElementById('auth-modal-title');
  const btnEl    = document.getElementById('btn-auth-submit');
  const toggleEl = document.getElementById('auth-toggle-text');
  if (titleEl)  titleEl.textContent  = register ? 'Crear cuenta' : 'Inicia sesión';
  if (btnEl)    btnEl.textContent    = register ? 'Crear cuenta' : 'Entrar';
  if (toggleEl) toggleEl.innerHTML   = register
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

/* ──────────────────────────────────────────────────────────
   CLOUD LISTS CRUD
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
  // Check for existing list with the same name → update; otherwise insert
  const existing = authState.lists.find(l => l.name === name);
  let error;
  if (existing) {
    ({ error } = await window.db
      .from('custom_lists')
      .update({ words, updated_at: new Date() })
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
