// POC : scrape une seule URL Cardmarket Lorcana et upsert dans Supabase.
// Usage :
//   node scrape-one.js <set_code> <card_number> <cardmarket_url>
// Exemple (Ohana Means Family Iconic) :
//   node scrape-one.js WSP 224 "https://www.cardmarket.com/fr/Lorcana/Products/Singles/Winterspell/Ohana-Means-Family-V11-Enchanted"
//
// L'URL exacte : prends-la directement dans ton navigateur sur la page Cardmarket de la carte.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const [, , setCode, cardNumber, cardmarketUrl] = process.argv;
if (!setCode || !cardNumber || !cardmarketUrl) {
  console.error('Usage: node scrape-one.js <set_code> <card_number> <cardmarket_url>');
  process.exit(1);
}

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Parse "200,00 €" / "1.234,56 €" / "176 €" → 200.00 / 1234.56 / 176.00
function parsePrice(txt) {
  if (!txt) return null;
  const m = String(txt).replace(/\s/g, '').match(/(-?\d{1,3}(?:[.\u00a0]\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  let s = m[1];
  // Format européen "1.234,56" → "1234.56"
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseInt0(txt) {
  if (!txt) return null;
  const m = String(txt).replace(/\s/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

async function scrape() {
  console.log('[1/4] Lancement Puppeteer...');
  const browser = await puppeteer.launch({
    headless: false, // mets true quand tu auras validé visuellement que Cloudflare passe
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  console.log('[2/4] Ouverture de', cardmarketUrl);
  try {
    await page.goto(cardmarketUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Cardmarket affiche parfois un Cloudflare challenge. Si headless=false, tu peux résoudre à la main.
    await page.waitForSelector('dl', { timeout: 30000 });
  } catch (e) {
    console.error('Erreur navigation :', e.message);
    await browser.close();
    process.exit(2);
  }

  console.log('[3/4] Extraction des prix...');
  // Cardmarket utilise une structure <dl> avec <dt>label</dt> <dd>value</dd>.
  // On extrait toutes les paires et on cherche par label texte.
  const pairs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('dl').forEach((dl) => {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      const n = Math.min(dts.length, dds.length);
      for (let i = 0; i < n; i++) {
        out.push({
          label: (dts[i].textContent || '').trim(),
          value: (dds[i].textContent || '').trim()
        });
      }
    });
    return out;
  });

  console.log('  Paires extraites :', pairs.length);
  if (pairs.length === 0) {
    console.warn('⚠ Aucune paire <dt>/<dd> trouvée. Dump HTML pour debug :');
    const html = await page.content();
    console.log(html.slice(0, 2000));
    await browser.close();
    process.exit(3);
  }

  // Helper : trouve la première paire dont le label contient une des chaînes
  const find = (...needles) => {
    for (const p of pairs) {
      const L = p.label.toLowerCase();
      if (needles.some((n) => L.includes(n.toLowerCase()))) return p.value;
    }
    return null;
  };

  const row = {
    set_code: setCode,
    card_number: cardNumber,
    cardmarket_url: cardmarketUrl,
    price_low:       parsePrice(find('De', 'From', 'À partir de')),
    price_trend:     parsePrice(find('Tendance', 'Price Trend', 'Prix tendanciel')),
    price_avg30:     parsePrice(find('30 jours', '30-days', '30 days')),
    price_avg7:      parsePrice(find('7 jours', '7-days', '7 days')),
    price_avg1:      parsePrice(find('1 jour', '1-day', '1 day')),
    available_count: parseInt0(find('Articles disponibles', 'Available items')),
    scraped_at:      new Date().toISOString(),
    scrape_error:    null
  };

  console.log('  Row parsée :', row);

  console.log('[4/4] Upsert Supabase...');
  const { error } = await sb
    .from('lorcana_cardmarket_prices')
    .upsert(row, { onConflict: 'set_code,card_number' });

  if (error) {
    console.error('Erreur Supabase :', error);
    process.exit(4);
  }

  console.log('✓ OK. Row enregistrée pour', `${setCode}/${cardNumber}`);
  await browser.close();
}

scrape().catch((e) => {
  console.error('Crash :', e);
  process.exit(99);
});
