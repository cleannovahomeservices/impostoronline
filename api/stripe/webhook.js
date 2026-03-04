import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Disable automatic body parsing so we can verify Stripe's signature
// over the exact raw bytes.
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const rawBody = await getRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    switch (event.type) {

      /* ── 1. Checkout completed ─────────────────────────────────────── */
      case 'checkout.session.completed': {
        const session  = event.data.object;
        const playerId = session.client_reference_id || session.metadata?.playerId;
        if (!playerId) break;

        const sub = await stripe.subscriptions.retrieve(session.subscription);

        await supabase.from('premium_players').upsert({
          player_id:             playerId,
          is_premium:            ['active', 'trialing'].includes(sub.status),
          current_period_end:    new Date(sub.current_period_end * 1000).toISOString(),
          stripe_customer_id:    session.customer,
          stripe_subscription_id: session.subscription,
          updated_at:            new Date().toISOString(),
        }, { onConflict: 'player_id' });
        break;
      }

      /* ── 2. Subscription updated (renewal, upgrade, downgrade…) ─────── */
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await supabase
          .from('premium_players')
          .update({
            is_premium:         ['active', 'trialing'].includes(sub.status),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            updated_at:         new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      /* ── 3. Subscription cancelled ───────────────────────────────────── */
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase
          .from('premium_players')
          .update({ is_premium: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      /* ── 4. Payment failed ───────────────────────────────────────────── */
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        if (!subId) break;
        await supabase
          .from('premium_players')
          .update({ is_premium: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
        break;
      }

      default:
        // Unhandled event — silently acknowledge
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Internal error handling event' });
  }

  return res.status(200).json({ received: true });
}
