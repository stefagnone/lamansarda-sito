// Vercel Serverless Function — ex endpoint "Prenota e paga online" (Stripe Checkout).
//
// DISMESSO il 2026-09-23. Motivo: il pagamento online con carta è stato tolto dal sito.
// Si prenota in un solo modo: richiesta con le date → nostra conferma → pagamento
// concordato (bonifico, PayPal o all'arrivo), senza commissioni. Bottone, testi e
// codice client sono stati rimossi da index.html; questo handler resta solo per
// rispondere 410 Gone a eventuali chiamate residue (vecchie cache, link, bot).
//
// Il blocco PRICING qui sotto resta INTATTO: test/pricing-sync.test.mjs lo confronta
// con quello identico in index.html (stima del totale mostrata all'ospite).
//
// ===== PRICING — tenere sincronizzato con l'altro file (index.html <-> api/checkout.js) =====
// Sconti soggiorno lungo. NESSUN minimo notti per prenotare. Arrotondamento a euro interi.
const RATES = { '1': 49, '2': 59 };
const DISCOUNTS = [                      // soglie in ordine DECRESCENTE
  { minNights: 28, pct: 0.25, label: 'monthly' },
  { minNights: 7,  pct: 0.10, label: 'weekly'  },
];
function pricing(nights, guests) {
  const rate = RATES[String(guests)] || 59;
  const gross = nights * rate;
  let pct = 0, label = '';
  for (const d of DISCOUNTS) { if (nights >= d.minNights) { pct = d.pct; label = d.label; break; } }
  const discount = Math.round(gross * pct);   // euro interi: identico su client e server
  return { nights, rate, gross, pct, label, discount, total: gross - discount };
}
// ===== /PRICING =====

export default async function handler(req, res) {
  // 2026-09-23: pagamento online dismesso (vedi commento in testa al file).
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'gone',
    message: "Il pagamento online non è più disponibile. Invia la richiesta con le date: ti confermiamo e concordiamo il pagamento (bonifico, PayPal o all'arrivo).",
  });
}
