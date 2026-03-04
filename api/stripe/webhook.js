import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Disable automatic body parsing so Stripe signature verification works
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
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log('[webhook] Stripe event received:', event.type);

  try {
    switch (event.type) {

      /* ── 1. Checkout completed ─────────────────────────────────────── */
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Primary identifier: customer email (always present on a completed checkout)
        const email    = session.customer_details?.email;
        // Fallback: UUID stored by the frontend at checkout creation time
        const playerId = email || session.client_reference_id || session.metadata?.playerId;

        console.log('[webhook] checkout.session.completed — email:', email);
        console.log('[webhook] player_id used for upsert:', playerId);
        console.log('[webhook] customer:', session.customer);
        console.log('[webhook] subscription:', session.subscription);

        if (!playerId) {
          console.error('[webhook] No player_id found — skipping upsert');
          break;
        }

        // Retrieve the subscription to get current_period_end
        let periodEnd = null;
        let subStatus = 'active';
        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            periodEnd = new Date(sub.current_period_end * 1000).toISOString();
            subStatus = sub.status;
            console.log('[webhook] subscription status:', subStatus, '| period_end:', periodEnd);
          } catch (subErr) {
            console.error('[webhook] Failed to retrieve subscription:', subErr.message);
          }
        }

        const { error: upsertErr } = await supabase
          .from('premium_players')
          .upsert({
            player_id:              playerId,
            is_premium:             ['active', 'trialing'].includes(subStatus),
            current_period_end:     periodEnd,
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription,
            updated_at:             new Date().toISOString(),
          }, { onConflict: 'player_id' });

        if (upsertErr) {
          console.error('[webhook] Supabase upsert failed:', upsertErr);
        } else {
          console.log('[webhook] Supabase upsert OK for player_id:', playerId);
        }
        break;
      }

      /* ── 2. Subscription updated ─────────────────────────────────────── */
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        console.log('[webhook] subscription.updated — id:', sub.id, '| status:', sub.status);

        const { error } = await supabase
          .from('premium_players')
          .update({
            is_premium:         ['active', 'trialing'].includes(sub.status),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            updated_at:         new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        if (error) console.error('[webhook] Supabase update failed:', error);
        break;
      }

      /* ── 3. Subscription cancelled ───────────────────────────────────── */
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('[webhook] subscription.deleted — id:', sub.id);

        const { error } = await supabase
          .from('premium_players')
          .update({ is_premium: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);

        if (error) console.error('[webhook] Supabase update failed:', error);
        break;
      }

      /* ── 4. Payment failed ───────────────────────────────────────────── */
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        console.log('[webhook] invoice.payment_failed — subscription:', subId);
        if (!subId) break;

        const { error } = await supabase
          .from('premium_players')
          .update({ is_premium: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);

        if (error) console.error('[webhook] Supabase update failed:', error);
        break;
      }

      default:
        console.log('[webhook] Unhandled event type:', event.type);
        break;
    }
  } catch (err) {
    console.error('[webhook] Unhandled exception:', err);
    // Still return 200 so Stripe doesn't keep retrying for logic errors
    return res.status(200).json({ received: true, warning: err.message });
  }

  return res.status(200).json({ received: true });
}
