// Stripe-Webhook: Stripe meldet hier Zahlungen, Abo-Änderungen und Kündigungen.
// Muss den ROHEN Request-Body bekommen (für die Signaturprüfung) – daher eigener Parser.
import express, { Router } from 'express';
import { constructWebhookEvent, handleStripeEvent } from '../services/billing.js';

export const stripeRouter = Router();

stripeRouter.post('/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.warn('[stripe] Ungültiger Webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    const result = await handleStripeEvent(event);
    if (result.handled && !result.duplicate) console.log(`[stripe] ${event.type} verarbeitet (Kunde ${result.tenantId})`);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] Fehler bei', event.type, err);
    res.status(500).json({ error: 'processing_failed' }); // Stripe versucht es später erneut
  }
});
