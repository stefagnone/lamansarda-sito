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
async function icalBusy() {
  const urls = [process.env.ICAL_AIRBNB, process.env.ICAL_BOOKING].filter(Boolean);
  if (urls.length === 0) return new Set();
  try {
    const texts = await Promise.all(urls.map(u =>
      fetchT(u, { headers: { 'User-Agent': 'LaMansarda/1.0' } }, 4000).then(r => (r.ok ? r.text() : '')).catch(() => '')
    ));
    let ranges = [];
    for (const t of texts) ranges = ranges.concat(parseICS(t));
    return expandDays(ranges);
  } catch { return new Set(); }
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
  const [ical, paid] = await Promise.all([icalBusy(), stripeBusy(key)]);
  const busy = new Set([...ical, ...paid]);
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
