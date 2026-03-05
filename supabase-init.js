/* ============================================================
   SUPABASE CLIENT INIT — supabase-init.js
   The anon key is safe to expose in frontend code.
   RLS policies protect your data.
   Find these values in: Supabase Dashboard → Settings → API
   ============================================================ */
(function () {
  var url = 'REPLACE_WITH_YOUR_SUPABASE_URL';       // e.g. https://abcxyz.supabase.co
  var key = 'REPLACE_WITH_YOUR_SUPABASE_ANON_KEY';  // starts with eyJ...

  if (!url || url.startsWith('REPLACE') || !key || key.startsWith('REPLACE')) {
    console.warn('[supabase] supabase-init.js: fill in SUPABASE_URL and SUPABASE_ANON_KEY');
    window.db = null;
    return;
  }
  try {
    window.db = supabase.createClient(url, key);
    console.log('[supabase] client ready');
  } catch (e) {
    console.error('[supabase] init error:', e);
    window.db = null;
  }
})();
