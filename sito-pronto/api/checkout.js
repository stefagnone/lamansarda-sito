// Vercel Serverless Function — crea una sessione Stripe Checkout per il soggiorno selezionato.
// Il prezzo viene SEMPRE ricalcolato qui lato server: non ci si fida dell'importo del client.
//
// CONFIGURAZIONE (Vercel → Project → Settings → Environment Variables):
//   STRIPE_SECRET_KEY = chiave segreta Stripe. In test usa sk_test_..., poi passa a sk_live_...
//   SITE_URL (opzionale) = origine per success/cancel URL (default: dominio della richiesta)
//
// Tariffe: TENERE ALLINEATE con RATES in index.html ({1:49, 2:59} €/notte).

const RATES = { '1': 49, '2': 59 };
const MAX_NIGHTS = 60;
const MAX_AHEAD_DAYS = 400;

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
}
function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function rangeDays(checkin, checkout) {
  const out = [];
  for (let d = new Date(checkin + 'T00:00:00Z'); d < new Date(checkout + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
async function fetchT(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

// --- Disponibilità da iCal (Airbnb/Booking), best-effort ---
function parseICS(text) {
  const ranges = [];
  for (const ev of text.split('BEGIN:VEVENT').slice(1)) {
    const s = /DTSTART[^:]*:(\d{8})/.exec(ev);
    const e = /DTEND[^:]*:(\d{8})/.exec(ev);
    if (!s) continue;
    ranges.push({ start: s[1], end: e ? e[1] : s[1] });
  }
  return ranges;
}
function expandDays(ranges) {
  const days = new Set();
  for (const r of ranges) {
    const a = new Date(`${r.start.slice(0,4)}-${r.start.slice(4,6)}-${r.start.slice(6,8)}T00:00:00Z`);
    const b = new Date(`${r.end.slice(0,4)}-${r.end.slice(4,6)}-${r.end.slice(6,8)}T00:00:00Z`);
    for (let d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) days.add(d.toISOString().slice(0, 10));
  }
  return days;
}
// Sorgenti iCal con identità: distingue fetch riuscito-con-0-eventi da fetch fallito.
const ICAL_SOURCES = [
  { key: 'airbnb', url: process.env.ICAL_AIRBNB },
  { key: 'booking', url: process.env.ICAL_BOOKING },
];
// { days:Set, sources:{airbnb:'ok'|'fail',...}, degraded:bool }
// Una sorgente fallita => degraded; i suoi giorni NON sono assunti liberi.
async function icalSources() {
  const active = ICAL_SOURCES.filter(s => s.url);
  const results = await Promise.all(active.map(async (s) => {
    try {
      const r = await fetchT(s.url, { headers: { 'User-Agent': 'LaMansarda/1.0' } }, 4000);
      if (!r.ok) return { key: s.key, ok: false, ranges: [] };
      return { key: s.key, ok: true, ranges: parseICS(await r.text()) };
    } catch { return { key: s.key, ok: false, ranges: [] }; }
  }));
  const sources = {}; let ranges = []; let degraded = false;
  for (const r of results) {
    sources[r.key] = r.ok ? 'ok' : 'fail';
    if (r.ok) ranges = ranges.concat(r.ranges); else degraded = true;
  }
  return { days: expandDays(ranges), sources, degraded };
}

// --- Disponibilità dalle prenotazioni pagate sul sito (Stripe è lo store: PI autorizzati o catturati) ---
async function stripeBusy(key) {
  if (!key) return new Set();
  try {
    const r = await fetchT('https://api.stripe.com/v1/payment_intents?limit=100', {
      headers: { Authorization: `Bearer ${key}` },
    }, 5000);
    if (!r.ok) return new Set();
    const data = await r.json();
    const days = new Set();
    for (const pi of (data.data || [])) {
      if (pi.status !== 'requires_capture' && pi.status !== 'succeeded' && pi.status !== 'processing') continue;
      const m = pi.metadata || {};
      if (!isISODate(m.checkin) || !isISODate(m.checkout)) continue;
      for (const d of rangeDays(m.checkin, m.checkout)) days.add(d);
    }
    return days;
  } catch { return new Set(); }
}
function rangeOverlaps(checkin, checkout, busy) {
  return rangeDays(checkin, checkout).some(d => busy.has(d));
}

// --- Alert host via Resend quando un pagamento è bloccato per sync degradato (stesso meccanismo di webhook.js) ---
let _lastAlert = 0;
const ALERT_THROTTLE_MS = 30 * 60 * 1000;
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
async function alertBlocked(sources, info) {
  const now = Date.now();
  if (now - _lastAlert < ALERT_THROTTLE_MS) return;
  _lastAlert = now;
  const host = process.env.HOST_EMAIL || 'paolocompagnone63@gmail.com';
  const failed = Object.entries(sources).filter(([, v]) => v === 'fail').map(([k]) => k).join(', ') || 'n/d';
  await sendEmail(host, '⚠️ Prenotazione bloccata: sync calendari non verificabile — La Mansarda',
    `<h2>Pagamento bloccato per sicurezza (anti-overbooking)</h2>
     <p>Un ospite ha provato a prenotare ma una sorgente iCal non è verificabile: <b>${failed}</b>.</p>
     <p>Date richieste: <b>${info}</b>.</p>
     <p>Verifica subito la disponibilità su Airbnb/Booking e, se libera, contatta l'ospite o sblocca le sorgenti iCal.</p>`);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return res.status(503).json({ error: 'not_configured', message: 'Pagamenti non ancora configurati.' });
  }

  const body = await readBody(req);
  const checkin = body.checkin;
  const checkout = body.checkout;
  const guests = String(body.guests);
  const lang = ['it', 'en', 'de', 'fr', 'es'].includes(body.lang) ? body.lang : 'auto';

  // --- Validazione lato server ---
  if (!isISODate(checkin) || !isISODate(checkout)) return res.status(400).json({ error: 'bad_dates' });
  if (!RATES[guests]) return res.status(400).json({ error: 'bad_guests' });
  const today = new Date().toISOString().slice(0, 10);
  if (checkin < today) return res.status(400).json({ error: 'past_date' });
  const nights = dayDiff(checkin, checkout);
  if (nights < 1) return res.status(400).json({ error: 'bad_range' });
  if (nights > MAX_NIGHTS) return res.status(400).json({ error: 'too_long' });
  if (dayDiff(today, checkin) > MAX_AHEAD_DAYS) return res.status(400).json({ error: 'too_far' });

  // --- Disponibilità: iCal (Airbnb/Booking) + prenotazioni pagate sul sito (Stripe) ---
  const [ical, paid] = await Promise.all([icalSources(), stripeBusy(key)]);
  // Se una sorgente iCal richiesta è fallita non possiamo escludere un overbooking:
  // NON creare la sessione come se fosse libero — blocca e segnala all'host.
  if (ical.degraded) {
    await alertBlocked(ical.sources, `${checkin} → ${checkout} (${guests} ospiti)`);
    return res.status(409).json({ error: 'sync_unverified', message: 'Verifica disponibilità in corso. Ti confermiamo a breve.' });
  }
  const busy = new Set([...ical.days, ...paid]);
  if (rangeOverlaps(checkin, checkout, busy)) {
    return res.status(409).json({ error: 'unavailable', message: 'Le date selezionate non sono più disponibili.' });
  }

  const rate = RATES[guests];
  const total = nights * rate;

  const origin = process.env.SITE_URL
    || req.headers.origin
    || (req.headers.host ? `https://${req.headers.host}` : 'https://www.lamansardanicosia.it');

  const guestLabel = guests === '1' ? 'ospite' : 'ospiti';

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${origin}/?paid=1&amount=${total}&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${origin}/?canceled=1#prenota`);
  params.set('line_items[0][quantity]', String(nights));
  params.set('line_items[0][price_data][currency]', 'eur');
  params.set('line_items[0][price_data][unit_amount]', String(rate * 100));
  params.set('line_items[0][price_data][product_data][name]', `Soggiorno La Mansarda Nicosia (${guests} ${guestLabel})`);
  params.set('line_items[0][price_data][product_data][description]', `Check-in ${checkin} · Check-out ${checkout}`);
  // autorizza ora, l'host cattura dopo aver confermato la disponibilità (entro 7 giorni)
  params.set('payment_intent_data[capture_method]', 'manual');
  // metadati anche sul PaymentIntent: servono per ricostruire le date occupate (vedi stripeBusy)
  params.set('payment_intent_data[metadata][checkin]', checkin);
  params.set('payment_intent_data[metadata][checkout]', checkout);
  params.set('payment_intent_data[metadata][guests]', guests);
  params.set('payment_intent_data[metadata][nights]', String(nights));
  params.set('phone_number_collection[enabled]', 'true');
  params.set('billing_address_collection', 'auto');
  params.set('metadata[checkin]', checkin);
  params.set('metadata[checkout]', checkout);
  params.set('metadata[guests]', guests);
  params.set('metadata[nights]', String(nights));
  params.set('metadata[total_eur]', String(total));
  if (lang !== 'auto') params.set('locale', lang);

  try {
    const r = await fetchT('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }, 8000);
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: 'stripe_error', message: (data && data.error && data.error.message) || 'Errore Stripe' });
    }
    return res.status(200).json({ url: data.url, total });
  } catch (err) {
    return res.status(502).json({ error: 'network', message: 'Impossibile contattare Stripe.' });
  }
}
