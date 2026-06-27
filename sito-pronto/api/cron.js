// Vercel Cron giornaliero — ciclo di vita ospite (post-checkout).
// Trova i soggiorni con check-out = IERI (fuso Europe/Rome) e invia UNA email di
// richiesta recensione Google (riusa il cid del sito). Email transazionale
// (esecuzione del contratto), niente consenso marketing, testo neutro.
//
// Dedup "una sola volta": flag persistente metadata.review_sent sul PaymentIntent.
// Schedulazione: vercel.json → "crons":[{ "path":"/api/cron", "schedule":"0 10 * * *" }]
//   (UTC; il calcolo di "ieri" è in Europe/Rome, quindi indipendente dall'ora del cron)
//
// CONFIGURAZIONE (Vercel → Settings → Environment Variables):
//   STRIPE_SECRET_KEY = per elencare i PaymentIntent e scrivere i metadata
//   RESEND_API_KEY / MAIL_FROM = invio email (come webhook.js)
//   CRON_SECRET (consigliato) = se impostato, l'endpoint richiede Authorization: Bearer <CRON_SECRET>
//                               (Vercel lo invia automaticamente alle esecuzioni cron)

const REVIEW_URL = 'https://www.google.com/maps?cid=10364661981123230684'; // stesso cid del sito

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  if (!apiKey || !from || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch { /* best-effort */ }
}

async function updatePIMetadata(key, piId, kv) {
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

// Data di IERI nel fuso Europe/Rome, come YYYY-MM-DD. Gestisce CET/CEST correttamente:
// prima si ottiene la data ODIERNA a Roma, poi si sottrae un giorno civile.
export function yesterdayRome(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // en-CA → "YYYY-MM-DD"
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

async function listSucceededPIs(key, maxPages = 5) {
  const out = [];
  let startingAfter = null;
  for (let p = 0; p < maxPages; p++) {
    const url = new URL('https://api.stripe.com/v1/payment_intents');
    url.searchParams.set('limit', '100');
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    let data;
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) break;
      data = await r.json();
    } catch { break; }
    const arr = data.data || [];
    out.push(...arr);
    if (!data.has_more || arr.length === 0) break;
    startingAfter = arr[arr.length - 1].id;
  }
  return out;
}

function reviewHtml() {
  const btn = `<a href="${REVIEW_URL}" target="_blank" rel="noopener" style="display:inline-block;background:#1f3a8a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">Lascia una recensione su Google · Leave a Google review</a>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1b2230;line-height:1.55">
  <h2 style="color:#14306e;margin:0 0 .4rem">Grazie per aver soggiornato da noi</h2>
  <p>Speriamo che il soggiorno a La Mansarda ti sia piaciuto. Se ti va, puoi raccontare la tua esperienza su Google: aiuta altri viaggiatori a trovarci.</p>
  <p style="text-align:center;margin:24px 0">${btn}</p>
  <p>Grazie e a presto,<br>Paolo e Stefano — La Mansarda Nicosia</p>
  <hr style="border:none;border-top:1px solid #e6e9ef;margin:1.2rem 0">
  <h3 style="color:#14306e;margin:0 0 .4rem">Thanks for staying with us</h3>
  <p>We hope you enjoyed your stay at La Mansarda. If you'd like, you can share your experience on Google — it helps other travellers find us.</p>
  <p>Thanks and see you soon,<br>Paolo and Stefano — La Mansarda Nicosia</p>
</div>`;
}

export default async function handler(req, res) {
  // sicurezza: se CRON_SECRET è impostato, richiedi l'header (Vercel lo invia ai cron)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && (req.headers['authorization'] || '') !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });

  const target = yesterdayRome();
  const pis = await listSucceededPIs(key);

  let candidates = 0, sent = 0, skipped = 0;
  for (const pi of pis) {
    if (pi.status !== 'succeeded') continue;            // solo pagamenti catturati (soggiorno avvenuto)
    const m = pi.metadata || {};
    if (m.checkout !== target) continue;                // check-out = ieri (Roma)
    candidates++;
    if (m.review_sent === '1') { skipped++; continue; } // già inviata → una sola volta
    const to = m.guest_email || pi.receipt_email || '';
    if (!to) { skipped++; continue; }
    await sendEmail(to, "La Mansarda Nicosia — com'è andato il soggiorno? · how was your stay?", reviewHtml());
    await updatePIMetadata(key, pi.id, { review_sent: '1' });
    sent++;
  }

  return res.status(200).json({ ok: true, date: target, candidates, sent, skipped });
}
