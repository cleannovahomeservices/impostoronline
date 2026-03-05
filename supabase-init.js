/* ============================================================
   SUPABASE CLIENT INIT — supabase-init.js
   Fetches public config from /api/config (reads Vercel env vars).
   Uses implicit flow — simpler for SPAs (token comes back in URL hash).
   Exposes window.supabaseReady (Promise) so auth.js can await it.
   ============================================================ */
window.db            = null;
window.supabaseReady = (async function () {
  try {
    console.log('[supabase] fetching config from /api/config…');
    const res = await fetch('/api/config');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`/api/config → HTTP ${res.status}: ${body}`);
    }

    const { supabaseUrl, supabaseAnon, error } = await res.json();

    if (error || !supabaseUrl || !supabaseAnon) {
      throw new Error(`/api/config missing values — error: ${error || 'url/key empty'}`);
    }

    window.db = supabase.createClient(supabaseUrl, supabaseAnon, {
      auth: {
        flowType:             'implicit',   // token in URL hash — works for static SPAs
        persistSession:       true,
        detectSessionInUrl:   true,
        autoRefreshToken:     true,
      },
    });

    // Alias used in the rest of the codebase
    window.supabaseClient = window.db;

    console.log('[supabase] ✓ client ready —', supabaseUrl);
    return window.supabaseClient;
  } catch (err) {
    console.error('[supabase] ✗ init failed:', err.message);
    return null;
  }
})();
