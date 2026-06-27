// Vercel Serverless Function — date occupate per il calendario.
// Unisce: (1) iCal Airbnb + Booking, (2) prenotazioni pagate sul sito (Stripe).
// Sola lettura. Distingue "fetch riuscito con 0 eventi" da "fetch fallito":
// un fetch fallito NON conta come 0 occupati (anti-overbooking su unità singola).
//
// CONFIGURAZIONE (Vercel → Project → Settings → Environment Variables):
//   ICAL_AIRBNB  = URL iCal di Airbnb  (.ics)
//   ICAL_BOOKING = URL iCal di Booking (.ics)
//   STRIPE_SECRET_KEY = per includere le prenotazioni pagate direttamente sul sito
//   RESEND_API_KEY / MAIL_FROM / HOST_EMAIL (opz.) = alert host se il sync è degradato

async function fetchT(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

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
function isISO(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

// Sorgenti iCal con identità (per tracciare ok/fail per-sorgente).
const SOURCES = [
  { key: 'airbnb', url: process.env.ICAL_AIRBNB },
  { key: 'booking', url: process.env.ICAL_BOOKING },
];

// Ritorna { days:Set, sources:{airbnb:'ok'|'fail',...}, degraded:bool }.
// Una sorgente fallita (rete/timeout/HTTP non-ok/parse) => degraded, e i suoi
// giorni NON vengono considerati liberi: semplicemente non sono verificabili.
async function icalSources() {
  const active = SOURCES.filter(s => s.url);
  const results = await Promise.all(active.map(async (s) => {
    try {
      const r = await fetchT(s.url, { headers: { 'User-Agent': 'LaMansarda/1.0' } }, 4000);
      if (!r.ok) return { key: s.key, ok: false, ranges: [] };
      return { key: s.key, ok: true, ranges: parseICS(await r.text()) };
    } catch { return { key: s.key, ok: false, ranges: [] }; }
  }));
  const sources = {};
  let ranges = [];
  let degraded = false;
  for (const r of results) {
    sources[r.key] = r.ok ? 'ok' : 'fail';
    if (r.ok) ranges = ranges.concat(r.ranges);
    else degraded = true;
  }
  return { days: expandDays(ranges), sources, degraded };
}

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
      if (!isISO(m.checkin) || !isISO(m.checkout)) continue;
      for (let d = new Date(m.checkin + 'T00:00:00Z'); d < new Date(m.checkout + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
        days.add(d.toISOString().slice(0, 10));
      }
    }
    return days;
  } catch { return new Set(); }
}

// --- Alert host via Resend quando il sync è degradato (stesso meccanismo di webhook.js) ---
let _lastAlert = 0;
const ALERT_THROTTLE_MS = 30 * 60 * 1000; // max ~1 email/30min per container
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
async function alertHostsDegraded(sources) {
  const now = Date.now();
  if (now - _lastAlert < ALERT_THROTTLE_MS) return;
  _lastAlert = now;
  const host = process.env.HOST_EMAIL || 'paolocompagnone63@gmail.com';
  const failed = Object.entries(sources).filter(([, v]) => v === 'fail').map(([k]) => k).join(', ') || 'n/d';
  await sendEmail(host, '⚠️ Sync calendari degradato — La Mansarda',
    `<h2>Calendario non verificabile in tempo reale</h2>
     <p>Sorgenti iCal non raggiungibili: <b>${failed}</b>.</p>
     <p>Per sicurezza il sito mostra l'avviso "disponibilità da confermare" e <b>blocca i pagamenti online</b> finché le sorgenti non tornano disponibili (anti-overbooking).</p>
     <p>Controlla gli URL iCal (ICAL_AIRBNB / ICAL_BOOKING) e lo stato di Airbnb/Booking.</p>`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.STRIPE_SECRET_KEY;

  try {
    const [ical, paid] = await Promise.all([icalSources(), stripeBusy(key)]);
    const busy = new Set([...ical.days, ...paid]);

    if (ical.degraded) {
      // non cacheare a lungo uno stato degradato: si recupera prima
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
      await alertHostsDegraded(ical.sources); // throttled, best-effort
    } else {
      res.setHeader('Cache-Control', 's-maxage=150, stale-while-revalidate=600');
    }

    return res.status(200).json({
      busy: [...busy].sort(),
      sources: ical.sources,
      degraded: ical.degraded,
      configured: SOURCES.some(s => s.url) || Boolean(key),
      updated: new Date().toISOString(),
    });
  } catch (err) {
    // errore inatteso: tratta come degradato (non come "tutto libero")
    res.setHeader('Cache-Control', 's-maxage=30');
    return res.status(200).json({ busy: [], degraded: true, sources: {}, configured: true, error: 'fetch_failed' });
  }
}
