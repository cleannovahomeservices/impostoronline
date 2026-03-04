import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { playerId } = req.query;
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId is required' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { data, error } = await supabase
    .from('premium_players')
    .select('is_premium, current_period_end')
    .eq('player_id', playerId)
    .maybeSingle();

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ error: 'Database error' });
  }

  if (!data) {
    return res.status(200).json({ premium: false, until: null });
  }

  const now   = new Date();
  const until = data.current_period_end ? new Date(data.current_period_end) : null;
  const premium = !!(data.is_premium && until && until > now);

  return res.status(200).json({ premium, until: until?.toISOString() ?? null });
}
