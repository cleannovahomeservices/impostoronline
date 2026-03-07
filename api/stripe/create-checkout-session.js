import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { playerId, user_id: userId, user_email: userEmail } = req.body || {};
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId is required' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const metadata = { playerId };
  if (userId && typeof userId === 'string') metadata.user_id = userId;
  if (userEmail && typeof userEmail === 'string') metadata.user_email = userEmail;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: playerId,
      metadata,
      // {CHECKOUT_SESSION_ID} is replaced by Stripe with the real session id.
      // The frontend uses it to retrieve the customer email after payment.
      success_url: `${process.env.APP_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/?checkout=cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
