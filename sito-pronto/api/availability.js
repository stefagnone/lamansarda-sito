// Vercel Serverless Function — date occupate per il calendario.
// Unisce: (1) iCal Airbnb + Booking, (2) prenotazioni pagate sul sito (Stripe).
// Sola lettura, nessun dato sensibile in output (solo elenco di giorni occupati).
//
// CONFIGURAZIONE (Vercel → Project → Settings → Environment Variables):
//   ICAL_AIRBNB  = URL iCal di Airbnb  (.ics)
//   ICAL_BOOKING = URL iCal di Booking (.ics)
//   STRIPE_SECRET_KEY = per includere le prenotazioni pagate direttamente sul sito

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urls = [process.env.ICAL_AIRBNB, process.env.ICAL_BOOKING].filter(Boolean);
  const key = process.env.STRIPE_SECRET_KEY;

  try {
    const [icalTexts, paid] = await Promise.all([
      Promise.all(urls.map(u =>
        fetchT(u, { headers: { 'User-Agent': 'LaMansarda/1.0' } }, 4000)
          .then(r => (r.ok ? r.text() : '')).catch(() => '')
      )),
      stripeBusy(key),
    ]);
    let ranges = [];
    for (const t of icalTexts) ranges = ranges.concat(parseICS(t));
    const busy = new Set([...expandDays(ranges), ...paid]);
    return res.status(200).json({
      busy: [...busy].sort(),
      configured: urls.length > 0 || Boolean(key),
      updated: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(200).json({ busy: [], configured: true, error: 'fetch_failed' });
  }
}
