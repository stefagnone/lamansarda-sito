// Verifica che pricing() in index.html (client) e api/checkout.js (server) siano
// IDENTICI sugli stessi input. Estrae il blocco fra i marker "===== PRICING".
// Esegui:  node test/pricing-sync.test.mjs
import { readFileSync } from 'node:fs';

const CLIENT = new URL('../sito-pronto/index.html', import.meta.url);
const SERVER = new URL('../sito-pronto/api/checkout.js', import.meta.url);

function extractPricing(file) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/\/\/ ===== PRICING[\s\S]*?\/\/ ===== \/PRICING =====/);
  if (!m) throw new Error(`Blocco PRICING non trovato in ${file}`);
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn pricing;`)();
}

const pClient = extractPricing(CLIENT);
const pServer = extractPricing(SERVER);

const NIGHTS = [1, 6, 7, 27, 28, 30, 60];
const GUESTS = ['1', '2'];

// valori attesi (sconti: -10% da 7 notti, -25% da 28; arrotondamento euro interi)
const EXPECT = {
  '1|2': 59, '6|2': 354, '7|2': 372, '27|2': 1434, '28|2': 1239,
  '1|1': 49, '7|1': 309, '28|1': 1029,
};

let pass = 0, fail = 0;
const log = (ok, msg) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

console.log('— client vs server identici —');
for (const g of GUESTS) for (const n of NIGHTS) {
  const a = JSON.stringify(pClient(n, g));
  const b = JSON.stringify(pServer(n, g));
  log(a === b, `pricing(${n},'${g}') client===server  ${a === b ? '' : '\n    client=' + a + '\n    server=' + b}`);
}

console.log('\n— totali attesi (casi 1/6/7/27/28) —');
for (const [k, exp] of Object.entries(EXPECT)) {
  const [n, g] = k.split('|');
  const got = pServer(Number(n), g).total;
  log(got === exp, `${n} notti, ${g} osp → totale ${got}€ (atteso ${exp}€)`);
}

console.log('\n— soglie sconto —');
log(pServer(6, '2').discount === 0, '6 notti: nessuno sconto');
log(pServer(7, '2').pct === 0.10 && pServer(7, '2').label === 'weekly', '7 notti: -10% weekly');
log(pServer(27, '2').pct === 0.10, '27 notti: ancora -10%');
log(pServer(28, '2').pct === 0.25 && pServer(28, '2').label === 'monthly', '28 notti: -25% monthly');

console.log(`\n${fail === 0 ? 'ALL PASS ✅' : 'FAIL ❌'}  (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
