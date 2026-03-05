/* ============================================================
   JUEGO IMPOSTOR 2 — app.js
   All game logic, state management, screen navigation
   ============================================================ */

/* ==================== PLAYER IDENTITY ==================== */
function getPlayerId() {
  let id = localStorage.getItem('playerId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('playerId', id);
  }
  console.log('[premium] playerId activo:', id);
  return id;
}

/* ==================== PREMIUM STATE ==================== */
const premiumState = {
  premium: false,
  until:   null,
  checked: false,
};

async function checkPremiumStatus({ silent = false } = {}) {
  const playerId = getPlayerId();
  console.log('[premium] checkPremiumStatus — usando playerId:', playerId);
  try {
    // Legacy fallback via backend API (kept for compatibility).
    // New primary source of truth is Supabase via checkPremium(user|null) in auth.js.
    const res = await fetch(`/api/premium/status?playerId=${encodeURIComponent(playerId)}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Status API returned non-JSON (${res.status})`);
    }
    const data = await res.json();
    renderPremiumUI(data.premium);
    return data.premium;
  } catch (err) {
    if (!silent) console.error('Premium check failed:', err);
    premiumState.checked = true;
    return false;
  }
}

function updatePremiumUI() {
  const banner = document.getElementById('premium-lock-banner');
  if (!banner) return;
  if (premiumState.premium) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
  }
}

// Central place to apply premium flag to game state + UI
function renderPremiumUI(isPremium) {
  premiumState.premium = !!isPremium;
  premiumState.checked = true;
  updatePremiumUI();
}

/* ─── Poll for premium after checkout (webhook may take a few seconds) ─── */
// Called when the user lands back from Stripe with ?checkout=success&session_id=cs_...
// Resolves session → email → stores email as the persistent playerId → checks premium.
async function handleCheckoutSuccess(sessionId) {
  try {
    const res         = await fetch(`/api/stripe/verify?sessionId=${encodeURIComponent(sessionId)}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data.email) {
      // Persist email as the device's playerId / player_email so legacy premium lookups work
      localStorage.setItem('playerId', data.email);
      localStorage.setItem('player_email', data.email);
      console.log('[premium] email stored as playerId/player_email:', data.email);
    }

    if (data.premium) {
      renderPremiumUI(data.premium);
      showPremiumToast('¡Premium activado! Bienvenido ⭐');
      return;
    }
  } catch (err) {
    console.warn('[premium] verify endpoint failed, falling back to poll:', err);
  }

  // Fallback: webhook might still be in flight — poll by the stored playerId
  await pollPremiumAfterCheckout();
}

async function pollPremiumAfterCheckout(maxAttempts = 6, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const isPremium = await checkPremiumStatus({ silent: true });
    if (isPremium) {
      showPremiumToast('¡Premium activado! Bienvenido ⭐');
      return;
    }
  }
}

/* ─── Toast notification ─── */
function showPremiumToast(msg) {
  let toast = document.getElementById('premium-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'premium-toast';
    toast.className = 'premium-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

/* ==================== PREMIUM MODAL ==================== */
function showPremiumModal() {
  document.getElementById('premium-modal').classList.remove('hidden');
}

function hidePremiumModal() {
  document.getElementById('premium-modal').classList.add('hidden');
}

function requirePremium(callback) {
  if (premiumState.premium) {
    callback();
  } else {
    showPremiumModal();
  }
}

function initPremiumModal() {
  document.getElementById('btn-premium-close').addEventListener('click', hidePremiumModal);

  document.getElementById('premium-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('premium-modal')) hidePremiumModal();
  });

  document.getElementById('btn-premium-checkout').addEventListener('click', async () => {
    const btn      = document.getElementById('btn-premium-checkout');
    const btnText  = document.getElementById('btn-premium-checkout-text');
    btn.disabled   = true;
    btnText.textContent = 'Redirigiendo…';

    try {
      const playerId = getPlayerId();
      const res = await fetch('/api/stripe/create-checkout-session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ playerId }),
      });

      // Guard: if the server returned HTML instead of JSON, surface a clear error
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server error ${res.status} — response is not JSON`);
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      console.error('Checkout error:', err);
      btnText.textContent = 'Error — inténtalo de nuevo';
      btn.disabled = false;
    }
  });

  /* ── Recovery: check premium by email ── */
  document.getElementById('btn-premium-recover').addEventListener('click', async () => {
    const emailInput = document.getElementById('premium-recover-email');
    const msg        = document.getElementById('premium-recover-msg');
    const btn        = document.getElementById('btn-premium-recover');
    const email      = emailInput.value.trim().toLowerCase();

    if (!email || !email.includes('@')) {
      showRecoverMsg('Introduce un email válido.', 'err');
      return;
    }

    btn.disabled     = true;
    btn.textContent  = '…';
    msg.className    = 'premium-recover-msg hidden';

    try {
      console.log('[premium] verificando premium por email:', email);
      const res = await fetch(`/api/premium/status?playerId=${encodeURIComponent(email)}`);
      const ct  = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.premium) {
        localStorage.setItem('playerId', email);
        console.log('[premium] email guardado como playerId:', email);
        premiumState.premium = true;
        premiumState.until   = data.until;
        premiumState.checked = true;
        updatePremiumUI();
        hidePremiumModal();
        showPremiumToast('¡Premium activado! Bienvenido ⭐');
      } else {
        showRecoverMsg('No se encontró Premium para ese email.', 'err');
      }
    } catch (err) {
      console.error('[premium] recovery error:', err);
      showRecoverMsg('Error al verificar. Inténtalo de nuevo.', 'err');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Verificar';
    }

    function showRecoverMsg(text, type) {
      msg.textContent = text;
      msg.className   = `premium-recover-msg ${type}`;
    }
  });
}

/* ==================== AI (proxied via /api/hints) ==================== */
async function generateHintsWithAI(words) {
  const res = await fetch('/api/hints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words }),
  });

  if (!res.ok) throw new Error(`Error del servidor: ${res.status}`);
  const data = await res.json();
  const content = data.choices[0].message.content.trim();
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in response');
  return JSON.parse(jsonMatch[0]);
}

function renderHintsTable(wordsWithHints) {
  const wrap = document.getElementById('hints-table-wrap');
  if (!wordsWithHints || wordsWithHints.length === 0) {
    wrap.innerHTML = '';
    return;
  }

  gameState.customWords = wordsWithHints.map(item => ({
    word: item.word,
    easyHint: item.easy || '',
    hardHint: item.hard || '',
  }));

  const n = wordsWithHints.length;
  wrap.innerHTML = `<div class="hints-ready">✅ Pistas generadas para ${n} palabra${n !== 1 ? 's' : ''}</div>`;
}

function syncCustomWordsFromTable() {
  const lines = document.getElementById('custom-words-textarea').value
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    gameState.customWords = lines.map(w => ({ word: w, easyHint: '', hardHint: '' }));
  }
  // If textarea is empty (e.g. a list was loaded), keep gameState.customWords as-is
}

/* ==================== SAVED LISTS (cloud if logged in, localStorage otherwise) ==================== */
async function saveList(name) {
  if (!name) return;
  // Cloud save if logged in
  if (typeof authState !== 'undefined' && authState.user) {
    await saveCloudList(name, gameState.customWords);
    return;
  }
  // No session: do not create new cloud entries — keep any existing local lists as read-only
  alert('Inicia sesión para guardar tus listas en la nube.');
}

function loadList(idOrName) {
  if (!idOrName) return;
  // Cloud load if logged in
  if (typeof authState !== 'undefined' && authState.user) {
    const list = authState.lists.find(l => l.id === idOrName);
    if (!list) return;
    const raw = list.words;
    gameState.customWords = Array.isArray(raw)
      ? raw.map(w => (typeof w === 'string' ? { word: w, easyHint: '', hardHint: '' } : w))
      : [];
    document.getElementById('custom-words-textarea').value = '';
    const n = gameState.customWords.length;
    const hasPistas = gameState.customWords.some(w => w.easyHint || w.hardHint);
    document.getElementById('hints-table-wrap').innerHTML =
      `<div class="hints-ready">📋 Lista "<strong>${list.name}</strong>" cargada · ${n} palabra${n !== 1 ? 's' : ''}${hasPistas ? ' · con pistas' : ''}</div>`;
    return;
  }
  // Local fallback
  const all = JSON.parse(localStorage.getItem('impostor_lists') || '{}');
  if (!all[idOrName]) return;
  const words = all[idOrName];
  gameState.customWords = words;
  document.getElementById('custom-words-textarea').value = '';
  const n = words.length;
  const hasPistas = words.some(w => w.easyHint || w.hardHint);
  document.getElementById('hints-table-wrap').innerHTML =
    `<div class="hints-ready">📋 Lista "<strong>${idOrName}</strong>" cargada · ${n} palabra${n !== 1 ? 's' : ''}${hasPistas ? ' · con pistas' : ''}</div>`;
}

async function deleteList(idOrName) {
  if (!idOrName) return;
  if (typeof authState !== 'undefined' && authState.user) {
    await deleteCloudList(idOrName);
    return;
  }
  const all = JSON.parse(localStorage.getItem('impostor_lists') || '{}');
  delete all[idOrName];
  localStorage.setItem('impostor_lists', JSON.stringify(all));
  populateSavedListsDropdown();
}

function populateSavedListsDropdown() {
  const select = document.getElementById('saved-lists-select');
  if (!select) return;

  // Cloud lists if logged in
  if (typeof authState !== 'undefined' && authState.user) {
    const lists = authState.lists || [];
    select.innerHTML = lists.length
      ? lists.map(l => `<option value="${l.id}" data-cloud="true">${l.name}</option>`).join('')
      : '<option value="" disabled selected>Sin listas en la nube</option>';
    return;
  }

  // Local lists
  const keys = Object.keys(JSON.parse(localStorage.getItem('impostor_lists') || '{}'));
  select.innerHTML = keys.length
    ? keys.map(k => `<option value="${k}">${k}</option>`).join('')
    : '<option value="" disabled selected>Sin listas guardadas</option>';
}

/* ==================== GAME STATE ==================== */
const gameState = {
  players: [],          // array of player name strings
  roles: [],            // 'jugador' | 'impostor' per player index
  word: null,           // selected secret word object {word, easyHint, hardHint}
  category: null,       // category id string
  impostorCount: 1,
  timerEnabled: false,
  timerMinutes: 3,
  hintMode: 'none',     // 'none' | 'easy' | 'hard'
  wordMode: 'random',   // 'random' | 'write' | 'category'
  customWords: [],       // [{word, easyHint, hardHint}] from textarea
  impostorMode: 'auto', // 'auto' | 'libre'
  // runtime
  currentCardIndex: 0,
  timerSeconds: 0,
  timerInterval: null,
  timerRunning: false,
  timerTotal: 0,
  eliminated: new Set(),
};

/* ==================== SCREEN NAVIGATION ==================== */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('active');
    el.scrollTop = 0;
    window.scrollTo(0, 0);
  }
}

/* ==================== ROLE ASSIGNMENT ==================== */
function assignRoles() {
  const n = gameState.players.length;
  let impostors = gameState.impostorMode === 'auto'
    ? Math.max(1, Math.floor(n / 4))
    : gameState.impostorCount;
  impostors = Math.min(impostors, n - 1);

  // Fisher-Yates shuffle on indices
  const indices = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  gameState.roles = new Array(n).fill('jugador');
  for (let i = 0; i < impostors; i++) {
    gameState.roles[indices[i]] = 'impostor';
  }
  gameState.impostorCount = impostors;
}

/* ==================== WORD SELECTION ==================== */
function selectWord() {
  let pool = [];

  if (gameState.wordMode === 'random') {
    const catKeys = Object.keys(CATEGORIES);
    const randomCat = catKeys[Math.floor(Math.random() * catKeys.length)];
    pool = CATEGORIES[randomCat].words;
    gameState.category = CATEGORIES[randomCat].name;
  } else if (gameState.wordMode === 'category') {
    const cat = CATEGORIES[gameState.category];
    if (cat) {
      pool = cat.words;
      gameState.category = cat.name;
    }
  } else if (gameState.wordMode === 'write') {
    pool = gameState.customWords;
    gameState.category = 'Lista personalizada';
  }

  if (!pool || pool.length === 0) {
    pool = CATEGORIES['animales'].words;
    gameState.category = CATEGORIES['animales'].name;
  }

  gameState.word = pool[Math.floor(Math.random() * pool.length)];
}

/* ==================== SETUP SCREEN ==================== */
function initSetupScreen() {
  // Player count pills
  const pillGroup = document.getElementById('player-count-pills');
  pillGroup.innerHTML = '';
  for (let i = 3; i <= 10; i++) {
    const pill = document.createElement('button');
    pill.className = 'pill' + (i === 5 ? ' active' : '');
    pill.textContent = i;
    pill.dataset.count = i;
    pill.addEventListener('click', () => {
      pillGroup.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      updatePlayerNameInputs(i);
      updateAutoImpostorDisplay(i);
    });
    pillGroup.appendChild(pill);
  }
  updatePlayerNameInputs(5);

  // Inline login button (under logo)
  document.getElementById('btn-inline-login')?.addEventListener('click', () => {
    if (typeof showAuthModal === 'function') showAuthModal();
  });

  // Word mode tabs — "write" tab requires premium
  document.querySelectorAll('.tab[data-mode]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.mode === 'write' && !premiumState.premium) {
        showPremiumModal();
        return;
      }
      document.querySelectorAll('.tab[data-mode]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      gameState.wordMode = tab.dataset.mode;
      document.querySelectorAll('.word-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`panel-${tab.dataset.mode}`).classList.add('active');
    });
  });

  // Category select
  const catSelect = document.getElementById('category-select');
  catSelect.innerHTML = '';
  Object.entries(CATEGORIES).forEach(([key, cat]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = cat.name;
    catSelect.appendChild(opt);
  });
  catSelect.addEventListener('change', () => {
    gameState.category = catSelect.value;
  });
  gameState.category = Object.keys(CATEGORIES)[0];

  // Hint difficulty
  document.querySelectorAll('.hint-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.hint-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      gameState.hintMode = pill.dataset.hint;
    });
  });

  // Impostor mode
  document.querySelectorAll('.pill[data-impostor-mode]').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill[data-impostor-mode]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      gameState.impostorMode = pill.dataset.impostorMode;
      document.getElementById('impostor-libre-row').classList.toggle('hidden', gameState.impostorMode !== 'libre');
    });
  });

  // Impostor libre slider
  const impostorSlider = document.getElementById('impostor-slider');
  const impostorSliderVal = document.getElementById('impostor-slider-val');
  impostorSlider.addEventListener('input', () => {
    gameState.impostorCount = parseInt(impostorSlider.value);
    impostorSliderVal.textContent = impostorSlider.value;
  });

  // Timer toggle
  const timerToggle = document.getElementById('timer-toggle');
  timerToggle.addEventListener('change', () => {
    gameState.timerEnabled = timerToggle.checked;
    document.getElementById('timer-stepper-wrap').classList.toggle('hidden', !timerToggle.checked);
  });

  // Timer stepper
  document.getElementById('timer-dec').addEventListener('click', () => {
    if (gameState.timerMinutes > 1) {
      gameState.timerMinutes--;
      document.getElementById('timer-val').textContent = gameState.timerMinutes;
    }
  });
  document.getElementById('timer-inc').addEventListener('click', () => {
    if (gameState.timerMinutes < 10) {
      gameState.timerMinutes++;
      document.getElementById('timer-val').textContent = gameState.timerMinutes;
    }
  });

  // Custom word list: sync words on typing (hints come from the AI table)
  document.getElementById('custom-words-textarea').addEventListener('input', () => {
    syncCustomWordsFromTable();
  });

  // Banner upgrade link inside the personalizado panel
  document.getElementById('btn-banner-upgrade')?.addEventListener('click', showPremiumModal);

  // AI generate hints button — requires premium
  document.getElementById('btn-generate-hints').addEventListener('click', async () => {
    if (!premiumState.premium) { showPremiumModal(); return; }
    const textareaLines = document.getElementById('custom-words-textarea').value
      .split('\n').map(l => l.trim()).filter(Boolean);
    // If textarea is empty (a list was loaded), fall back to words stored in gameState
    const words = textareaLines.length > 0
      ? textareaLines
      : gameState.customWords.map(w => w.word).filter(Boolean);
    if (!words.length) return;

    const loadingEl = document.getElementById('hints-loading');
    const btn = document.getElementById('btn-generate-hints');
    loadingEl.classList.remove('hidden');
    btn.disabled = true;

    try {
      const results = await generateHintsWithAI(words);
      renderHintsTable(results);
    } catch (err) {
      console.error(err);
      alert('Error al generar pistas. Revisa la consola para más detalles.');
    } finally {
      loadingEl.classList.add('hidden');
      btn.disabled = false;
    }
  });

  // Save / Load / Delete list buttons
  document.getElementById('btn-save-list').addEventListener('click', async () => {
    const name = document.getElementById('list-name-input').value.trim();
    if (!name) return;
    const btn = document.getElementById('btn-save-list');
    btn.disabled    = true;
    btn.textContent = 'Guardando…';
    await saveList(name);
    btn.disabled    = false;
    btn.textContent = 'Guardar';
    document.getElementById('list-name-input').value = '';
  });

  document.getElementById('btn-load-list').addEventListener('click', () => {
    const val = document.getElementById('saved-lists-select').value;
    if (val) loadList(val);
  });

  document.getElementById('btn-delete-list').addEventListener('click', async () => {
    const val = document.getElementById('saved-lists-select').value;
    if (!val) return;
    const btn = document.getElementById('btn-delete-list');
    btn.disabled    = true;
    btn.textContent = '…';
    await deleteList(val);
    btn.disabled    = false;
    btn.textContent = 'Eliminar';
  });

  populateSavedListsDropdown();

  // Start button
  document.getElementById('btn-start').addEventListener('click', startGame);

  updateAutoImpostorDisplay(5);
}


function updatePlayerNameInputs(count) {
  const container = document.getElementById('player-names-container');
  const existing = container.querySelectorAll('input');
  const values = Array.from(existing).map(i => i.value);

  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'player-name-row';
    row.innerHTML = `
      <span class="player-num">${i + 1}.</span>
      <input type="text" maxlength="20" placeholder="Jugador ${i + 1}" value="${values[i] || ''}">
    `;
    container.appendChild(row);
  }

  // Update impostor libre slider max
  const slider = document.getElementById('impostor-slider');
  if (slider) {
    slider.max = Math.max(1, count - 1);
    if (parseInt(slider.value) > count - 1) {
      slider.value = count - 1;
      gameState.impostorCount = count - 1;
      document.getElementById('impostor-slider-val').textContent = slider.value;
    }
  }
}

function updateAutoImpostorDisplay(count) {
  const auto = Math.max(1, Math.floor(count / 4));
  const el = document.getElementById('auto-impostor-display');
  if (el) el.textContent = `Auto: ${auto} impostor${auto > 1 ? 'es' : ''}`;
}

function getPlayerCount() {
  const activePill = document.querySelector('#player-count-pills .pill.active');
  return activePill ? parseInt(activePill.dataset.count) : 5;
}

function startGame() {
  // Collect player names
  const inputs = document.querySelectorAll('#player-names-container input');
  gameState.players = Array.from(inputs).map((inp, i) => inp.value.trim() || `Jugador ${i + 1}`);

  // Word mode: collect category/custom
  if (gameState.wordMode === 'category') {
    gameState.category = document.getElementById('category-select').value;
  }

  // Run logic
  assignRoles();
  selectWord();
  gameState.currentCardIndex = 0;
  gameState.eliminated = new Set();

  showScreen('screen-roles');
  renderRoleCard();
}

/* ==================== ROLE ASSIGNMENT SCREEN ==================== */
const COVER_IMAGES = [
  'images/cover1.png',
  'images/cover2.png',
  'images/cover3.png',
  'images/cover4.png',
  'images/cover5.png',
  'images/cover6.png',
];

function renderRoleCard() {
  const idx = gameState.currentCardIndex;
  const total = gameState.players.length;
  const playerName = gameState.players[idx];

  // Progress
  document.getElementById('role-progress-label').textContent = `Jugador ${idx + 1} de ${total}`;
  const pct = ((idx) / total) * 100;
  document.getElementById('role-progress-fill').style.width = pct + '%';

  // Player name
  document.getElementById('role-player-name').textContent = playerName;

  // Cover image — rotate through the 6 images
  const coverImg = document.getElementById('role-cover-img');
  coverImg.src = COVER_IMAGES[idx % COVER_IMAGES.length];

  // Reset card to unflipped
  const card3d = document.getElementById('role-card-3d');
  card3d.classList.remove('flipped');

  // Reset back face to neutral (hidden until flip phase 2)
  const backFace = document.getElementById('role-card-back');
  backFace.className = 'card-face card-face-back';
  backFace.innerHTML = '';

  // Lock next button
  const nextBtn = document.getElementById('btn-role-next');
  nextBtn.disabled = true;
  nextBtn.textContent = idx === total - 1 ? 'Comenzar Juego' : `Pasar a ${gameState.players[idx + 1] || '...'}`;

  // Card flip handler — phase 1: front scales out; phase 2 (after 350ms): back scales in
  card3d.onclick = () => {
    if (card3d.classList.contains('flipped')) return;
    card3d.classList.add('flipped');
    setTimeout(() => {
      renderBackFace(backFace, idx);
      backFace.classList.add('flip-visible');
      nextBtn.disabled = false;
    }, 350);
  };

  // Tap hint on front face
  document.getElementById('role-tap-text').textContent = `Toca para revelar el rol de ${playerName}`;
}

function renderBackFace(el, idx) {
  const role = gameState.roles[idx];
  const isImpostor = role === 'impostor';
  el.className = `card-face card-face-back role-${role}`;

  let hintHtml = '';
  if (gameState.hintMode !== 'none' && isImpostor) {
    const h = gameState.hintMode === 'easy' ? gameState.word.easyHint : gameState.word.hardHint;
    if (h) hintHtml = `<div class="role-hint">Pista para el impostor: ${h}</div>`;
  }

  if (isImpostor) {
    el.innerHTML = `
      <div class="role-badge">Tu rol</div>
      <div class="role-title">🕵️ IMPOSTOR</div>
      <div class="role-word" style="background:rgba(0,0,0,0.3)">??? Palabra desconocida</div>
      ${hintHtml}
    `;
  } else {
    el.innerHTML = `
      <div class="role-badge">Tu rol</div>
      <div class="role-title">✅ JUGADOR</div>
      <div class="role-word">${gameState.word.word}</div>
      ${hintHtml}
    `;
  }
}

function initRolesScreen() {
  document.getElementById('btn-role-next').addEventListener('click', () => {
    const total = gameState.players.length;
    if (gameState.currentCardIndex === total - 1) {
      // Last player — start game
      startTimerScreen();
    } else {
      gameState.currentCardIndex++;
      renderRoleCard();
    }
  });
}

/* ==================== GAME / TIMER SCREEN ==================== */
function startTimerScreen() {
  showScreen('screen-game');

  // Player chips
  const chipsEl = document.getElementById('game-player-chips');
  chipsEl.innerHTML = '';
  gameState.players.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'player-chip';
    chip.textContent = name;
    chipsEl.appendChild(chip);
  });

  if (gameState.timerEnabled) {
    document.getElementById('no-timer-note').classList.add('hidden');
    document.getElementById('timer-ring-section').classList.remove('hidden');
    gameState.timerSeconds = gameState.timerMinutes * 60;
    gameState.timerTotal = gameState.timerSeconds;
    gameState.timerRunning = true;
    updateTimerDisplay();
    startTimerInterval();
    document.getElementById('btn-pause').textContent = 'Pausar';
    document.getElementById('btn-pause').classList.remove('hidden');
  } else {
    document.getElementById('no-timer-note').classList.remove('hidden');
    document.getElementById('timer-ring-section').classList.add('hidden');
    document.getElementById('btn-pause').classList.add('hidden');
    gameState.timerRunning = false;
  }
}

function startTimerInterval() {
  clearInterval(gameState.timerInterval);
  gameState.timerInterval = setInterval(() => {
    if (!gameState.timerRunning) return;
    gameState.timerSeconds--;
    updateTimerDisplay();
    if (gameState.timerSeconds <= 0) {
      clearInterval(gameState.timerInterval);
      gameState.timerRunning = false;
      // Auto go to voting
      goToVoting();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const s = Math.max(0, gameState.timerSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  document.getElementById('timer-display').textContent =
    `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

  // SVG ring
  const svgCircle = document.getElementById('timer-progress-circle');
  if (svgCircle) {
    const r = 70;
    const circumference = 2 * Math.PI * r;
    const fraction = gameState.timerTotal > 0 ? s / gameState.timerTotal : 0;
    svgCircle.style.strokeDasharray = circumference;
    svgCircle.style.strokeDashoffset = circumference * (1 - fraction);
  }
}

function initGameScreen() {
  document.getElementById('btn-pause').addEventListener('click', () => {
    if (!gameState.timerEnabled) return;
    gameState.timerRunning = !gameState.timerRunning;
    document.getElementById('btn-pause').textContent = gameState.timerRunning ? 'Pausar' : 'Reanudar';
  });

  document.getElementById('btn-go-voting').addEventListener('click', goToVoting);
}

function goToVoting() {
  clearInterval(gameState.timerInterval);
  gameState.timerRunning = false;
  showScreen('screen-voting');
  renderVotingScreen();
}

/* ==================== VOTING SCREEN ==================== */
function renderVotingScreen() {
  const grid = document.getElementById('vote-grid');
  grid.innerHTML = '';
  gameState.eliminated = new Set();

  gameState.players.forEach((name, i) => {
    const card = document.createElement('div');
    card.className = 'vote-card';
    card.dataset.idx = i;

    const initial = name.charAt(0).toUpperCase();
    card.innerHTML = `
      <div class="vote-avatar">${initial}</div>
      <div class="vote-name">${name}</div>
    `;

    card.addEventListener('click', () => {
      card.classList.toggle('eliminated');
      if (card.classList.contains('eliminated')) {
        gameState.eliminated.add(i);
      } else {
        gameState.eliminated.delete(i);
      }
    });

    grid.appendChild(card);
  });
}

function initVotingScreen() {
  document.getElementById('btn-reveal').addEventListener('click', () => {
    showScreen('screen-results');
    renderResults();
  });
}

/* ==================== RESULTS SCREEN ==================== */
function renderResults() {
  const impostorIndices = gameState.roles
    .map((r, i) => (r === 'impostor' ? i : null))
    .filter(i => i !== null);

  // Win condition: all impostors were eliminated
  const allImpostorsEliminated = impostorIndices.every(i => gameState.eliminated.has(i));
  // Lose condition: any eliminated player is NOT an impostor
  const anyInnocentEliminated = [...gameState.eliminated].some(i => gameState.roles[i] !== 'impostor');

  const villageWins = allImpostorsEliminated && !anyInnocentEliminated;

  // Outcome header
  const outcomeEl = document.getElementById('results-outcome');
  const descEl = document.getElementById('results-desc');

  if (villageWins) {
    outcomeEl.textContent = '¡La aldea ganó!';
    outcomeEl.className = 'results-outcome win';
    descEl.textContent = '¡Atraparon a todos los impostores!';
    triggerConfetti();
  } else if (allImpostorsEliminated && anyInnocentEliminated) {
    outcomeEl.textContent = '¡Victoria parcial!';
    outcomeEl.className = 'results-outcome win';
    descEl.textContent = 'Impostores eliminados, pero también algún inocente.';
    triggerConfetti();
  } else if (!allImpostorsEliminated && gameState.eliminated.size > 0) {
    outcomeEl.textContent = '¡Los impostores ganan!';
    outcomeEl.className = 'results-outcome lose';
    descEl.textContent = 'Los impostores sobrevivieron. ¡Mejor suerte la próxima vez!';
    triggerRedFlash();
  } else {
    // No one eliminated or mixed
    outcomeEl.textContent = 'Fin de la partida';
    outcomeEl.className = 'results-outcome';
    descEl.textContent = 'Veamos quiénes eran los impostores…';
  }

  // Impostor list
  const impostorsList = document.getElementById('impostors-list');
  impostorsList.innerHTML = '';
  impostorIndices.forEach(i => {
    const el = document.createElement('div');
    el.className = 'impostor-reveal fade-in-up';
    el.innerHTML = `
      <span class="impostor-icon">🕵️</span>
      <div>
        <div class="impostor-name">${gameState.players[i]}</div>
        <div style="font-size:0.8rem;color:var(--text-muted)">era el impostor</div>
      </div>
    `;
    impostorsList.appendChild(el);
  });

  // Secret word
  document.getElementById('secret-word-value').textContent = gameState.word ? gameState.word.word : '?';
  document.getElementById('secret-category').textContent = gameState.category || '';
}

function initResultsScreen() {
  document.getElementById('btn-play-again').addEventListener('click', resetToSetup);
}

function resetToSetup() {
  clearInterval(gameState.timerInterval);
  gameState.timerRunning = false;
  gameState.timerInterval = null;
  gameState.currentCardIndex = 0;
  gameState.eliminated = new Set();
  showScreen('screen-setup');
}

/* ==================== CONFETTI ==================== */
function triggerConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const particles = [];
  const colors = ['#e040fb', '#00e5ff', '#ffeb3b', '#4caf50', '#ff6b35', '#fff'];

  for (let i = 0; i < 140; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      r: Math.random() * 7 + 3,
      c: colors[Math.floor(Math.random() * colors.length)],
      vx: Math.random() * 3 - 1.5,
      vy: Math.random() * 4 + 2,
      rot: Math.random() * 360,
      rotSpeed: Math.random() * 5 - 2.5,
    });
  }

  let frame;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6);
      ctx.restore();
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.rotSpeed;
      if (p.y > canvas.height) {
        p.y = -10;
        p.x = Math.random() * canvas.width;
      }
    });
    frame = requestAnimationFrame(draw);
  }

  draw();
  setTimeout(() => {
    cancelAnimationFrame(frame);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, 4000);
}

function triggerRedFlash() {
  const overlay = document.getElementById('flash-overlay');
  overlay.className = 'red-flash';
  overlay.style.opacity = '1';
  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.className = '';
  }, 1400);
}

/* ==================== SERVICE WORKER ==================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}

/* ==================== BOOT ==================== */
document.addEventListener('DOMContentLoaded', () => {
  initSetupScreen();
  initRolesScreen();
  initGameScreen();
  initVotingScreen();
  initResultsScreen();
  initPremiumModal();
  initAuthModal();
  showScreen('screen-setup');

  // Auth + premium status (non-blocking)
  initAuth();

  // Handle return from Stripe Checkout
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    // Clean URL without a reload
    history.replaceState(null, '', window.location.pathname);
    const sessionId = params.get('session_id');
    if (sessionId) {
      // Use the session id to resolve the customer email and confirm premium
      handleCheckoutSuccess(sessionId);
    } else {
      // Legacy fallback (no session_id in URL)
      pollPremiumAfterCheckout();
    }
  }
});
