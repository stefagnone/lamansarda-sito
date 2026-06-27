// Vercel Serverless Function — webhook Stripe.
// Verifica la firma (HMAC, anti-replay) e, su pagamento autorizzato, invia email
// di notifica all'host e di conferma all'ospite. Tutto è opzionale e attivato da env var:
// se manca STRIPE_WEBHOOK_SECRET o RESEND_API_KEY, la funzione non rompe nulla.
//
// CONFIGURAZIONE (Vercel → Settings → Environment Variables):
//   STRIPE_WEBHOOK_SECRET = "Signing secret" dell'endpoint webhook (Stripe → Sviluppatori → Webhook)
//   STRIPE_SECRET_KEY = per leggere/scrivere i metadata del PaymentIntent (dedup + email pre-arrivo)
//   RESEND_API_KEY (opzionale) = chiave Resend per inviare le email
//   MAIL_FROM (opzionale)      = mittente verificato, es. "La Mansarda <prenotazioni@tuodominio.it>"
//   HOST_EMAIL (opzionale)     = destinatario notifiche host (default: paolocompagnone63@gmail.com)
//
// In Stripe crea l'endpoint su  https://www.lamansardanicosia.it/api/webhook  e iscrivilo a:
//   - checkout.session.completed  (notifica host + conferma ospite — già presente)
//   - payment_intent.succeeded    (email pre-arrivo all'ospite quando catturi il pagamento)
//   - checkout.session.expired    (email di recupero del checkout abbandonato, con link "riprendi")
// NB: "payment_intent.captured" NON esiste in Stripe; con la cattura manuale l'evento che
//     scatta alla cattura è payment_intent.succeeded (il suo oggetto porta i metadata del PI).

import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

function verifySignature(payload, header, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  // anti-replay: rifiuta timestamp troppo vecchi
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch { /* best-effort */ }
}

// --- Idempotenza per event.id ---
// Stripe ritenta la consegna su timeout/5xx con lo STESSO event.id (firma e timestamp
// rigenerati a ogni tentativo, quindi l'anti-replay non li scarta). A basso volume basta
// un Set in memoria del modulo che ricorda gli ultimi N event.id (best-effort, per-container).
const SEEN_MAX = 500;
const seenEvents = new Set();
function alreadyProcessed(id) { return !!id && seenEvents.has(id); }
function markProcessed(id) {
  if (!id) return;
  seenEvents.add(id);
  // evita crescita illimitata: scarta il più vecchio (il Set conserva l'ordine d'inserimento)
  if (seenEvents.size > SEEN_MAX) seenEvents.delete(seenEvents.values().next().value);
}

// --- Email pre-arrivo (ospite) + helper metadata PaymentIntent ---
const ADDRESS = 'Via Costanza Bruno 1, 94014 Nicosia (EN), Sicilia';
const MAPS = 'https://www.google.com/maps?q=Via+Costanza+Bruno+1,+94014+Nicosia+EN,+Italia';
const PHONE = '+39 347 7054576';
const WA = 'https://wa.me/393477054576';
const HOST_MAIL_PUBLIC = 'paolocompagnone63@gmail.com';

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function updatePIMetadata(piId, kv) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !piId) return;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(kv)) params.set(`metadata[${k}]`, String(v));
  try {
    await fetch(`https://api.stripe.com/v1/payment_intents/${piId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch { /* best-effort */ }
}
function prearrivalHtml(m) {
  const ci = m.checkin || '', co = m.checkout || '';
  const range = ci ? ` (${ci} → ${co})` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1b2230;line-height:1.55">
  <h2 style="color:#14306e;margin:0 0 .4rem">La tua prenotazione è confermata 🎉</h2>
  <p>Ciao! Ecco le informazioni utili per il tuo arrivo a La Mansarda${range}.</p>
  <ul style="padding-left:1.1rem">
    <li><b>Indirizzo:</b> ${ADDRESS} — <a href="${MAPS}">apri in Google Maps</a></li>
    <li><b>Parcheggio:</b> privato e gratuito in loco (anche per moto); all'arrivo ti spieghiamo come raggiungerlo.</li>
    <li><b>⚠️ Importante:</b> l'appartamento è al <b>4° piano senza ascensore</b> (4 rampe di scale).</li>
    <li><b>Check-in:</b> 14:00–00:00 (scrivici l'orario di arrivo) · <b>Check-out:</b> 10:00–10:30</li>
    <li><b>Accesso:</b> ti accogliamo di persona e ti consegniamo le chiavi — scrivici su <a href="${WA}">WhatsApp</a> quando sei in arrivo.</li>
    <li><b>Colazione di base inclusa.</b></li>
  </ul>
  <p>Per qualsiasi cosa: WhatsApp/tel ${PHONE} · <a href="mailto:${HOST_MAIL_PUBLIC}">${HOST_MAIL_PUBLIC}</a></p>
  <p>A presto,<br>Paolo e Stefano — La Mansarda Nicosia</p>
  <hr style="border:none;border-top:1px solid #e6e9ef;margin:1.2rem 0">
  <h3 style="color:#14306e;margin:0 0 .4rem">Your booking is confirmed 🎉</h3>
  <p>Hi! Here's the useful info for your arrival at La Mansarda${range}.</p>
  <ul style="padding-left:1.1rem">
    <li><b>Address:</b> ${ADDRESS} — <a href="${MAPS}">open in Google Maps</a></li>
    <li><b>Parking:</b> free private parking on site (motorbikes too); we'll show you how to reach it on arrival.</li>
    <li><b>⚠️ Please note:</b> the flat is on the <b>4th floor with no lift</b> (4 flights of stairs).</li>
    <li><b>Check-in:</b> 2:00 PM–12:00 AM (tell us your arrival time) · <b>Check-out:</b> 10:00–10:30 AM</li>
    <li><b>Access:</b> we welcome you in person and hand over the keys — message us on <a href="${WA}">WhatsApp</a> when you're on your way.</li>
    <li><b>Basic breakfast included.</b></li>
  </ul>
  <p>Anything you need: WhatsApp/phone ${PHONE} · <a href="mailto:${HOST_MAIL_PUBLIC}">${HOST_MAIL_PUBLIC}</a></p>
  <p>See you soon,<br>Paolo and Stefano — La Mansarda Nicosia</p>
</div>`;
}

function recoveryHtml(m, url) {
  const ci = (m && m.checkin) || '', co = (m && m.checkout) || '';
  const range = ci ? `${ci} → ${co}` : '';
  const btn = `<a href="${url}" style="display:inline-block;background:#1f3a8a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">Riprendi la prenotazione · Resume booking</a>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1b2230;line-height:1.55">
  <h2 style="color:#14306e;margin:0 0 .4rem">La tua prenotazione ti aspetta</h2>
  <p>${range ? `Le date <b>${range}</b> che guardavi sono ancora disponibili.` : 'Le date che guardavi sono ancora disponibili.'} Puoi completare la prenotazione a La Mansarda da qui:</p>
  <p style="text-align:center;margin:24px 0">${btn}</p>
  <p>Per qualsiasi cosa scrivici su WhatsApp ${PHONE}. A presto,<br>Paolo e Stefano — La Mansarda Nicosia</p>
  <hr style="border:none;border-top:1px solid #e6e9ef;margin:1.2rem 0">
  <h3 style="color:#14306e;margin:0 0 .4rem">Your booking is waiting</h3>
  <p>${range ? `The dates <b>${range}</b> you were looking at are still available.` : 'The dates you were looking at are still available.'} You can complete your booking at La Mansarda here:</p>
  <p style="text-align:center;margin:24px 0">${btn}</p>
  <p>Any questions, message us on WhatsApp ${PHONE}. See you soon,<br>Paolo and Stefano — La Mansarda Nicosia</p>
</div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const payload = await rawBody(req);

  if (!secret) {
    // non configurato: accetta senza agire (evita retry infiniti da Stripe)
    return res.status(200).json({ received: true, note: 'webhook secret not set' });
  }
  if (!verifySignature(payload, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  let event;
  try { event = JSON.parse(payload); } catch { return res.status(400).json({ error: 'bad_json' }); }

  if (event.type === 'checkout.session.completed') {
    // idempotenza: scarta un event.id già processato (retry Stripe) PRIMA di inviare email
    if (alreadyProcessed(event.id)) {
      return res.status(200).json({ received: true, duplicate: true });
    }
    // claim prima dell'invio: dedup anche di retry concorrenti nello stesso container
    markProcessed(event.id);

    const s = event.data.object || {};
    const m = s.metadata || {};
    const cd = s.customer_details || {};
    const total = m.total_eur || (s.amount_total != null ? Math.round(s.amount_total / 100) : '');
    const host = process.env.HOST_EMAIL || 'paolocompagnone63@gmail.com';
    const summary = `Check-in ${m.checkin || '?'} · Check-out ${m.checkout || '?'} · ${m.guests || '?'} ospiti · ${m.nights || '?'} notti · ${total}€`;

    await sendEmail(host, `Nuova prenotazione (autorizzata) — ${summary}`,
      `<h2>Nuova prenotazione da confermare</h2><p>${summary}</p>
       <p>Ospite: ${cd.email || 'n/d'} · Tel: ${cd.phone || 'n/d'} · ${cd.name || ''}</p>
       <p><b>Azione richiesta:</b> verifica la disponibilità su Airbnb/Booking, poi <b>cattura</b> (o annulla) il pagamento dal dashboard Stripe <b>entro 7 giorni</b>.</p>`);

    if (cd.email) {
      await sendEmail(cd.email, 'La Mansarda Nicosia — pagamento ricevuto',
        `<h2>Grazie per la tua prenotazione!</h2>
         <p>Abbiamo ricevuto e <b>autorizzato</b> il pagamento per:</p><p><b>${summary}</b></p>
         <p>Verifichiamo la disponibilità e ti confermiamo a breve via email. L'addebito avviene solo alla conferma; se le date non fossero disponibili non verrà addebitato nulla.</p>
         <p>A presto,<br>Paolo e Stefano — La Mansarda Nicosia</p>`);
    }

    // salva l'email ospite sul PaymentIntent: serve a pre-arrivo (payment_intent.succeeded) e al cron recensione
    if (s.payment_intent && cd.email) {
      await updatePIMetadata(s.payment_intent, { guest_email: cd.email });
    }
  }

  // --- Pre-arrivo: alla cattura (payment_intent.succeeded) invia all'ospite le info per l'arrivo ---
  if (event.type === 'payment_intent.succeeded') {
    if (alreadyProcessed(event.id)) return res.status(200).json({ received: true, duplicate: true });
    markProcessed(event.id);
    const pi = event.data.object || {};
    // dedup persistente: l'evento è una snapshot congelata, rileggi i metadata aggiornati del PI
    const fresh = await stripeGet(`/payment_intents/${pi.id}`);
    const meta = Object.assign({}, pi.metadata, fresh && fresh.metadata);
    if (meta.prearrival_sent === '1') return res.status(200).json({ received: true, duplicate: true });
    const to = meta.guest_email || pi.receipt_email || '';
    if (to) {
      await sendEmail(to, 'La Mansarda Nicosia — informazioni per il tuo arrivo / arrival info', prearrivalHtml(meta));
      await updatePIMetadata(pi.id, { prearrival_sent: '1' });
    }
    return res.status(200).json({ received: true, prearrival: to ? 'sent' : 'no_email' });
  }

  // --- Recupero checkout abbandonato: alla scadenza invia il link "riprendi" (1 sola email per event.id) ---
  if (event.type === 'checkout.session.expired') {
    if (alreadyProcessed(event.id)) return res.status(200).json({ received: true, duplicate: true });
    markProcessed(event.id);
    const s = event.data.object || {};
    const rec = s.after_expiration && s.after_expiration.recovery;
    const url = rec && rec.url;                                  // link per riprendere (esiste solo se recovery abilitato)
    const to = (s.customer_details && s.customer_details.email) || s.customer_email || '';
    if (url && to) {
      await sendEmail(to, 'La Mansarda Nicosia — la tua prenotazione ti aspetta / your booking is waiting', recoveryHtml(s.metadata || {}, url));
      return res.status(200).json({ received: true, recovery: 'sent' });
    }
    return res.status(200).json({ received: true, recovery: 'skipped' });
  }

  return res.status(200).json({ received: true });
}
