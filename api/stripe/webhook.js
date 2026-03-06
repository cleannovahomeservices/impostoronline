import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Disable Vercel / Next.js automatic body parsing so Stripe can verify the
// HMAC signature over the exact raw bytes it sent.
export const config = { api: { bodyParser: false } };

// ─── Utility: collect raw body ────────────────────────────────────────────────
//
// Priority order:
//   1. req.rawBody  – some Vercel middleware versions pre-store it here
//   2. req.body     – already a Buffer or utf-8 string (some runtimes)
//   3. stream       – body not yet consumed (bodyParser disabled)
//   4. JSON.stringify(req.body) – last-resort fallback when body was
//                                  pre-parsed as an object; signature will
//                                  likely fail (Stripe will retry), but we
//                                  will NOT crash with 500.
//
async function getRawBody(req) {
  // 1. Explicit raw body cached by Vercel or custom middleware
  if (req.rawBody != null) {
    const r = req.rawBody;
    return Buffer.isBuffer(r) ? r : Buffer.from(String(r), 'utf8');
  }

  // 2a. Already a Buffer
  if (Buffer.isBuffer(req.body)) return req.body;

  // 2b. Already a utf-8 string
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');

  // 3. Stream-based reading (bodyParser disabled path)
  const streamBody = await readStream(req);
  if (streamBody !== null) return streamBody;

  // 4. Last-resort: re-serialize the already-parsed object.
  //    Signature verification will almost certainly fail, but at least
  //    we get a 400 (Stripe retries) instead of a 500 (same).
  if (req.body != null && typeof req.body === 'object') {
    console.warn('[webhook] ⚠️  body already parsed as object — serialising back to JSON. '
      + 'Signature verification will likely fail. '
      + 'Ensure bodyParser:false config is active for this function.');
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }

  throw new Error('Could not obtain raw body from any source');
}

function readStream(req) {
  return new Promise((resolve) => {
    // If the stream is already closed / not readable, resolve immediately
    if (!req.readable) {
      resolve(null);
      return;
    }

    const chunks = [];
    let settled = false;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    // Safety timeout — if the stream hangs without emitting data or end,
    // give up and let the caller fall back to req.body.
    const timer = setTimeout(() => {
      if (chunks.length > 0) {
        finish(Buffer.concat(chunks)); // partial but better than nothing
      } else {
        finish(null); // signal "nothing arrived"
      }
    }, 6000);

    req.on('data',  (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',   ()  => finish(Buffer.concat(chunks)));
    req.on('error', ()  => finish(chunks.length ? Buffer.concat(chunks) : null));
  });
}

// ─── Required env-var check (logged without printing secrets) ─────────────────
const REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

function checkEnvVars() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('[webhook] ❌ Missing env vars:', missing.join(', '));
    return false;
  }
  console.log('[webhook] ✅ Env vars present:', REQUIRED.map((k) => `${k}=✓`).join(' '));
  return true;
}

// ─── Safe timestamptz helper ───────────────────────────────────────────────────
function toISO(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

// Read current_period_end from a Stripe subscription object and convert
// it to an ISO string suitable for a Supabase timestamptz column.
function stripePeriodEndToTimestamp(sub) {
  if (!sub || !sub.current_period_end) return null;
  return new Date(sub.current_period_end * 1000).toISOString();
}

function isAfterNow(isoString) {
  if (!isoString) return false;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return false;
  return t > Date.now();
}

function computeIsPremium({ status, currentPeriodEnd, cancelAtPeriodEnd }) {
  const activeLike = ['active', 'trialing'].includes(status);
  if (activeLike) return true;

  // If canceled/unpaid/etc but the paid period is still running, keep access
  const keepUntilEndStatuses = ['canceled', 'unpaid', 'incomplete_expired', 'past_due'];
  if (keepUntilEndStatuses.includes(status) && isAfterNow(currentPeriodEnd)) return true;

  // cancel_at_period_end alone never removes access early
  if (cancelAtPeriodEnd && isAfterNow(currentPeriodEnd)) return true;

  return false;
}

async function findPremiumRow(supabase, { stripeCustomerId, stripeSubscriptionId, userId, playerId }) {
  // Order required by user:
  // 1) stripe_customer_id
  // 2) stripe_subscription_id
  // 3) user_id
  // 4) player_id/email
  const tryOne = async (col, val) => {
    if (!val) return null;
    const { data, error } = await supabase
      .from('premium_players')
      .select('player_id,current_period_end')
      .eq(col, val)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') {
      console.error('[webhook] ❌ findPremiumRow error on', col, ':', JSON.stringify(error));
      return null;
    }
    return data || null;
  };

  return (
    (await tryOne('stripe_customer_id', stripeCustomerId)) ||
    (await tryOne('stripe_subscription_id', stripeSubscriptionId)) ||
    (await tryOne('user_id', userId)) ||
    (await tryOne('player_id', playerId)) ||
    null
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. Env vars ───────────────────────────────────────────────────────────
  if (!checkEnvVars()) {
    // We own this misconfiguration — return 500 so Stripe retries
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const {
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  } = process.env;

  // ── 2. Raw body ───────────────────────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await getRawBody(req);
    console.log('[webhook] raw body length:', rawBody.length, 'bytes');
  } catch (err) {
    // We couldn't read the body at all — tell Stripe to retry (400, not 500)
    console.error('[webhook] ❌ getRawBody error:', err.message);
    return res.status(400).json({ error: 'Could not read request body' });
  }

  if (!rawBody || rawBody.length === 0) {
    console.error('[webhook] ❌ Empty raw body');
    return res.status(400).json({ error: 'Empty request body' });
  }

  // ── 3. Stripe signature verification ─────────────────────────────────────
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    console.error('[webhook] ❌ Missing Stripe-Signature header');
    return res.status(400).json({ error: 'Missing Stripe-Signature header' });
  }

  let stripe;
  let event;
  try {
    stripe = new Stripe(STRIPE_SECRET_KEY);
    event  = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] ❌ constructEvent failed:', err.message);
    return res.status(400).json({ error: `Signature error: ${err.message}` });
  }

  console.log('[webhook] ✅ Event verified:', event.type, '| id:', event.id);

  // ── 4. Supabase client ────────────────────────────────────────────────────
  let supabase;
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  } catch (err) {
    // Init failure — return 200 so Stripe stops retrying (config error)
    console.error('[webhook] ❌ Supabase createClient failed:', err.message);
    return res.status(200).json({ received: true, warning: 'supabase-init-failed' });
  }

  // ── 5. Event handling ─────────────────────────────────────────────────────
  //
  //  Any exception here returns 200 (stop Stripe from retrying) so we must
  //  log everything for manual inspection via Vercel function logs.
  //
  try {
    switch (event.type) {

      // ── checkout.session.completed ────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;

        const email    = session.customer_details?.email   ?? null;
        const playerId = email
          || session.client_reference_id
          || session.metadata?.playerId
          || null;

        console.log('[webhook] checkout.session.completed');
        console.log('[webhook]   email         :', email);
        console.log('[webhook]   player_id     :', playerId);
        console.log('[webhook]   customer      :', session.customer);
        console.log('[webhook]   subscription  :', session.subscription);

        if (!playerId) {
          console.error('[webhook] ❌ No player_id found — skipping upsert');
          break;
        }

        // Retrieve subscription for full state
        let periodEnd = null;
        let subStatus = 'active';
        let cancelAtPeriodEnd = false;

        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            subStatus       = sub.status;
            periodEnd       = stripePeriodEndToTimestamp(sub);
            cancelAtPeriodEnd = !!sub.cancel_at_period_end;
            console.log('[webhook]   sub status    :', subStatus);
            console.log('[webhook]   period_end    :', periodEnd);
            console.log('[webhook]   cancel_at_period_end:', cancelAtPeriodEnd);
          } catch (subErr) {
            console.error('[webhook] ⚠️  subscription.retrieve failed:', subErr.message);
            // Fall back to 30 days from now so is_premium can be set
            periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            console.log('[webhook]   period_end fallback:', periodEnd);
          }
        }

        const isPremium = computeIsPremium({
          status: subStatus,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd,
        });

        const { error: upsertErr } = await supabase
          .from('premium_players')
          .upsert(
            {
              player_id:              playerId,
              is_premium:             isPremium,
              stripe_customer_id:     session.customer     ?? null,
              stripe_subscription_id: session.subscription ?? null,
              current_period_end:     periodEnd,
              subscription_status:    subStatus ?? null,
              cancel_at_period_end:   cancelAtPeriodEnd,
              updated_at:             new Date().toISOString(),
            },
            { onConflict: 'player_id' },
          );

        if (upsertErr) {
          console.error('[webhook] ❌ Supabase upsert FAILED:', JSON.stringify(upsertErr));
        } else {
          console.log('[webhook] ✅ Supabase upsert OK — player_id:', playerId);
        }
        break;
      }

      // ── customer.subscription.updated ─────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const periodEnd  = stripePeriodEndToTimestamp(sub);
        const isPremium  = computeIsPremium({
          status: sub.status,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        });

        console.log('[webhook] subscription.updated id:', sub.id, '| status:', sub.status, '| period_end:', periodEnd);

        const existing = await findPremiumRow(supabase, {
          stripeCustomerId: sub.customer ?? null,
          stripeSubscriptionId: sub.id,
        });

        if (!existing?.player_id) {
          console.warn('[webhook] ⚠️ subscription.updated: no matching premium_players row found for sub/customer');
          break;
        }

        const { error } = await supabase.from('premium_players')
          .update({
            is_premium:           isPremium,
            current_period_end:   periodEnd,
            subscription_status:  sub.status ?? null,
            cancel_at_period_end: !!sub.cancel_at_period_end,
            updated_at:           new Date().toISOString(),
          })
          .eq('player_id', existing.player_id);

        if (error) console.error('[webhook] ❌ update FAILED:', JSON.stringify(error));
        else       console.log('[webhook] ✅ subscription.updated OK');
        break;
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('[webhook] subscription.deleted id:', sub.id);

        const existing = await findPremiumRow(supabase, {
          stripeCustomerId: sub.customer ?? null,
          stripeSubscriptionId: sub.id,
        });

        if (!existing?.player_id) {
          console.warn('[webhook] ⚠️ subscription.deleted: no matching premium_players row found for sub/customer');
          break;
        }

        const { error } = await supabase.from('premium_players')
          .update({
            is_premium:           false,
            subscription_status:  'canceled',
            cancel_at_period_end: false,
            updated_at:           new Date().toISOString(),
          })
          .eq('player_id', existing.player_id);

        if (error) console.error('[webhook] ❌ update FAILED:', JSON.stringify(error));
        else       console.log('[webhook] ✅ subscription.deleted OK');
        break;
      }

      // ── invoice.paid ───────────────────────────────────────────────────────
      case 'invoice.paid': {
        const invoice = event.data.object;
        const subId   = invoice.subscription ?? null;
        const custId  = invoice.customer ?? null;
        console.log('[webhook] invoice.paid | subscription:', subId);
        if (!subId) break;

        let sub;
        try {
          sub = await stripe.subscriptions.retrieve(subId);
        } catch (e) {
          console.error('[webhook] ⚠️ invoice.paid subscription.retrieve failed:', e.message);
          break;
        }

        const periodEnd = stripePeriodEndToTimestamp(sub);
        const isPremium = computeIsPremium({
          status: sub.status,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        });

        const existing = await findPremiumRow(supabase, {
          stripeCustomerId: custId,
          stripeSubscriptionId: subId,
        });
        if (!existing?.player_id) {
          console.warn('[webhook] ⚠️ invoice.paid: no matching premium_players row found for sub/customer');
          break;
        }

        const { error } = await supabase.from('premium_players')
          .update({
            is_premium:           isPremium,
            current_period_end:   periodEnd,
            subscription_status:  sub.status ?? null,
            cancel_at_period_end: !!sub.cancel_at_period_end,
            updated_at:           new Date().toISOString(),
          })
          .eq('player_id', existing.player_id);

        if (error) console.error('[webhook] ❌ invoice.paid update FAILED:', JSON.stringify(error));
        else       console.log('[webhook] ✅ invoice.paid handled OK');
        break;
      }

      // ── invoice.payment_failed ────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId   = invoice.subscription ?? null;
        const custId  = invoice.customer ?? null;
        console.log('[webhook] invoice.payment_failed | subscription:', subId);

        if (!subId) break;

        // Do NOT remove premium immediately — keep access until period end.
        // Only update subscription_status (+ related metadata).
        let sub;
        try {
          sub = await stripe.subscriptions.retrieve(subId);
        } catch (e) {
          console.error('[webhook] ⚠️ invoice.payment_failed subscription.retrieve failed:', e.message);
          sub = null;
        }

        const existing = await findPremiumRow(supabase, {
          stripeCustomerId: custId,
          stripeSubscriptionId: subId,
        });

        if (!existing?.player_id) {
          console.warn('[webhook] ⚠️ invoice.payment_failed: no matching premium_players row found for sub/customer');
          break;
        }

        const { error } = await supabase.from('premium_players')
          .update({
            subscription_status:  sub?.status ?? 'payment_failed',
            cancel_at_period_end: sub ? !!sub.cancel_at_period_end : undefined,
            current_period_end:   sub ? stripePeriodEndToTimestamp(sub) : undefined,
            updated_at:           new Date().toISOString(),
          })
          .eq('player_id', existing.player_id);

        if (error) console.error('[webhook] ❌ update FAILED:', JSON.stringify(error));
        else       console.log('[webhook] ✅ invoice.payment_failed handled OK');
        break;
      }

      default:
        console.log('[webhook] ℹ️  Unhandled event type (ignored):', event.type);
    }
  } catch (err) {
    // Controlled fallback — log everything, return 200 to stop Stripe retries
    console.error('[webhook] ❌ Exception in event handler:', err?.message);
    console.error('[webhook]    stack:', err?.stack);
  }

  return res.status(200).json({ received: true });
}
