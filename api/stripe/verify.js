import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/stripe/verify?sessionId=cs_...
 *
 * Resolves a Stripe Checkout Session ID to the customer email,
 * then looks up that email in Supabase to return the premium status.
 *
 * Called by the frontend when it lands on /?checkout=success&session_id=...
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sessionId } = req.query;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  let email;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    email = session.customer_details?.email;
    console.log('[verify] session retrieved, email:', email);
  } catch (err) {
    console.error('[verify] Stripe session retrieve failed:', err.message);
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  if (!email) {
    return res.status(200).json({ premium: false, email: null });
  }

  const { data } = await supabase
    .from('premium_players')
    .select('is_premium,current_period_end,subscription_status,cancel_at_period_end')
    .eq('player_id', email)
    .maybeSingle();

  const premium = !!(data?.is_premium);

  return res.status(200).json({
    email,
    premium,
    until: data?.current_period_end ?? null,
    current_period_end: data?.current_period_end ?? null,
    subscription_status: data?.subscription_status ?? null,
    cancel_at_period_end: data?.cancel_at_period_end ?? false,
  });
}
