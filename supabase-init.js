/* ============================================================
   SUPABASE CLIENT INIT — supabase-init.js
   Fetches public config from /api/config (reads Vercel env vars).
   Exposes window.supabaseReady (Promise) so auth.js can await it.
   ============================================================ */
window.db            = null;
window.supabaseReady = (async function () {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`/api/config returned ${res.status}`);

    const { supabaseUrl, supabaseAnon } = await res.json();
    if (!supabaseUrl || !supabaseAnon) {
      console.error('[supabase] /api/config returned empty URL or anon key');
      return null;
    }

    window.db = supabase.createClient(supabaseUrl, supabaseAnon);
    console.log('[supabase] client ready ✓');
    return window.db;
  } catch (err) {
    console.error('[supabase] init error:', err);
    return null;
  }
})();
