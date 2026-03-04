import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Tell Vercel (and Next.js) not to pre-parse the body — Stripe needs the raw bytes
// to verify the HMAC signature.
export const config = { api: { bodyParser: false } };

// ─── Raw body reader ──────────────────────────────────────────────────────────
// Returns a Buffer from the request stream.
// If Vercel already consumed the stream (body pre-parsed), req.body is used as
// fallback so signature verification can still be attempted.
function getRawBody(req) {
  // Fast path: body was pre-parsed by Vercel as a Buffer
  if (req.body instanceof Buffer) return Promise.resolve(req.body);
  // Body was pre-parsed as a string
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);

    // Safety valve: if nothing arrives in 8 s, fail cleanly
    setTimeout(() => reject(new Error('getRawBody timeout')), 8000);
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  console.log('[webhook] request method:', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Check required env vars ────────────────────────────────────────────
  const {
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[webhook] Missing env vars:', {
      STRIPE_SECRET_KEY:      !!STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET:  !!STRIPE_WEBHOOK_SECRET,
      SUPABASE_URL:           !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
    });
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // ── 2. Read raw body ──────────────────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await getRawBody(req);
    console.log('[webhook] raw body bytes:', rawBody.length);
  } catch (err) {
    console.error('[webhook] getRawBody failed:', err.message);
    return res.status(500).json({ error: 'Could not read request body' });
  }

  if (rawBody.length === 0) {
    console.error('[webhook] Empty body received');
    return res.status(400).json({ error: 'Empty body' });
  }

  // ── 3. Verify Stripe signature ────────────────────────────────────────────
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    console.error('[webhook] Missing stripe-signature header');
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let stripe;
  let event;
  try {
    stripe = new Stripe(STRIPE_SECRET_KEY);
    event  = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] constructEvent failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  console.log('[webhook] event:', event.type, '| id:', event.id);

  // ── 4. Initialise Supabase ────────────────────────────────────────────────
  let supabase;
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  } catch (err) {
    console.error('[webhook] createClient failed:', err.message);
    // Return 200 so Stripe doesn't keep retrying — this is a config error
    return res.status(200).json({ received: true, warning: 'Supabase init failed' });
  }

  // ── 5. Handle events ──────────────────────────────────────────────────────
  // Any unhandled exception inside here returns 200 (not 500) so Stripe stops retrying.
  try {
    switch (event.type) {

      // ── checkout.session.completed ───────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;

        const email    = session.customer_details?.email ?? null;
        const playerId = email
          || session.client_reference_id
          || session.metadata?.playerId
          || null;

        console.log('[webhook] checkout.session.completed');
        console.log('[webhook]   email          :', email);
        console.log('[webhook]   player_id      :', playerId);
        console.log('[webhook]   customer       :', session.customer);
        console.log('[webhook]   subscription   :', session.subscription);

        if (!playerId) {
          console.error('[webhook] No player_id — cannot upsert');
          break;
        }

        // Try to get current_period_end from the subscription
        let periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30-day default
        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            periodEnd = new Date(sub.current_period_end * 1000).toISOString();
            console.log('[webhook]   sub status     :', sub.status);
            console.log('[webhook]   period_end     :', periodEnd);
          } catch (subErr) {
            console.error('[webhook] subscription.retrieve failed:', subErr.message, '— using 30-day default');
          }
        }

        const { error: upsertErr } = await supabase
          .from('premium_players')
          .upsert(
            {
              player_id:              playerId,
              is_premium:             true,
              stripe_customer_id:     session.customer,
              stripe_subscription_id: session.subscription,
              current_period_end:     periodEnd,
              updated_at:             new Date().toISOString(),
            },
            { onConflict: 'player_id' },
          );

        if (upsertErr) {
          console.error('[webhook] Supabase upsert FAILED:', JSON.stringify(upsertErr));
        } else {
          console.log('[webhook] Supabase upsert OK — player_id:', playerId);
        }
        break;
      }

      // ── customer.subscription.updated ────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        console.log('[webhook] subscription.updated id:', sub.id, 'status:', sub.status);

        const { error } = await supabase
          .from('premium_players')
          .update({
            is_premium:         ['active', 'trialing'].includes(sub.status),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            updated_at:         new Date().toISOString(),
          })
          .eq('stripe_subscription_id', sub.id);

        if (error) console.error('[webhook] update FAILED:', JSON.stringify(error));
        break;
      }

      // ── customer.subscription.deleted ────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('[webhook] subscription.deleted id:', sub.id);

        const { error } = await supabase
          .from('premium_players')
          .update({ is_premium: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);

        if (error) console.error('[webhook] update FAILED:', JSON.stringify(error));
        break;
      }

      // ── invoice.payment_failed ────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId   = invoice.subscription;
        console.log('[webhook] invoice.payment_failed subscription:', subId);
        if (!subId) break;

        const { error } = await supabase
          .from('premium_players')
          .update({ is_premium: false, updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);

        if (error) console.error('[webhook] update FAILED:', JSON.stringify(error));
        break;
      }

      default:
        console.log('[webhook] unhandled event type:', event.type);
    }
  } catch (err) {
    // Log the full error but still return 200 to prevent Stripe from retrying
    console.error('[webhook] exception in event handler:', err?.message, err?.stack);
  }

  return res.status(200).json({ received: true });
}
