// Vercel Serverless Function — webhook Stripe.
// Verifica la firma (HMAC, anti-replay) e, su pagamento autorizzato, invia email
// di notifica all'host e di conferma all'ospite. Tutto è opzionale e attivato da env var:
// se manca STRIPE_WEBHOOK_SECRET o RESEND_API_KEY, la funzione non rompe nulla.
//
// CONFIGURAZIONE (Vercel → Settings → Environment Variables):
//   STRIPE_WEBHOOK_SECRET = "Signing secret" dell'endpoint webhook (Stripe → Sviluppatori → Webhook)
//   RESEND_API_KEY (opzionale) = chiave Resend per inviare le email
//   MAIL_FROM (opzionale)      = mittente verificato, es. "La Mansarda <prenotazioni@tuodominio.it>"
//   HOST_EMAIL (opzionale)     = destinatario notifiche host (default: paolocompagnone63@gmail.com)
//
// In Stripe crea l'endpoint su  https://www.lamansardanicosia.it/api/webhook
// e iscrivilo all'evento  checkout.session.completed.

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
  }

  return res.status(200).json({ received: true });
}
