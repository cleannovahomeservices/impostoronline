export default function handler(req, res) {
  const url  = process.env.SUPABASE_URL       || '';
  const anon = process.env.SUPABASE_ANON_KEY  || '';

  if (!url || !anon) {
    console.error('[config] SUPABASE_URL or SUPABASE_ANON_KEY env var is missing');
    return res.status(500).json({ error: 'Supabase config not set' });
  }

  // These are public values — the anon key is designed to be exposed in the browser
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ supabaseUrl: url, supabaseAnon: anon });
}
