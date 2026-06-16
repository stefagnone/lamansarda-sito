// Vercel Serverless Function — legge i calendari iCal di Airbnb e Booking
// e restituisce le date occupate come JSON. Sola lettura, nessun dato sensibile.
//
// CONFIGURAZIONE (in Vercel → Project → Settings → Environment Variables):
//   ICAL_AIRBNB  = URL di esportazione iCal di Airbnb  (finisce in .ics)
//   ICAL_BOOKING = URL di esportazione iCal di Booking (finisce in .ics)
// Se non impostate, la funzione restituisce semplicemente nessuna data occupata.

function parseICS(text) {
  // Estrae le date occupate dai blocchi VEVENT (DTSTART..DTEND, fine esclusiva).
  const ranges = [];
  const events = text.split('BEGIN:VEVENT').slice(1);
  for (const ev of events) {
    const s = /DTSTART[^:]*:(\d{8})/.exec(ev);
    const e = /DTEND[^:]*:(\d{8})/.exec(ev);
    if (!s) continue;
    const start = s[1];
    const end = e ? e[1] : start;
    ranges.push({ start, end });
  }
  return ranges;
}

function expandDays(ranges) {
  // Espande gli intervalli in singoli giorni occupati (YYYY-MM-DD), fine esclusiva.
  const days = new Set();
  for (const r of ranges) {
    const a = new Date(`${r.start.slice(0,4)}-${r.start.slice(4,6)}-${r.start.slice(6,8)}T00:00:00Z`);
    const b = new Date(`${r.end.slice(0,4)}-${r.end.slice(4,6)}-${r.end.slice(6,8)}T00:00:00Z`);
    for (let d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
      days.add(d.toISOString().slice(0, 10));
    }
  }
  return [...days].sort();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urls = [process.env.ICAL_AIRBNB, process.env.ICAL_BOOKING].filter(Boolean);
  if (urls.length === 0) {
    return res.status(200).json({ busy: [], configured: false });
  }

  try {
    const texts = await Promise.all(
      urls.map(u =>
        fetch(u, { headers: { 'User-Agent': 'LaMansarda/1.0' } })
          .then(r => (r.ok ? r.text() : ''))
          .catch(() => '')
      )
    );
    let ranges = [];
    for (const t of texts) ranges = ranges.concat(parseICS(t));
    const busy = expandDays(ranges);
    return res.status(200).json({ busy, configured: true, updated: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({ busy: [], configured: true, error: 'fetch_failed' });
  }
}
