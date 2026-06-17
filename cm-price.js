// /api/cm-price.js — Scrape la fiche d'une carte Cardmarket et renvoie ses prix
// Usage : GET /api/cm-price?url=https%3A%2F%2Fwww.cardmarket.com%2Ffr%2FPokemon%2FProducts%2FSingles%2F151%2FCharmeleon-MEW169
// Renvoie : { url, prices: { trend, avg30, avg7, avg1, low }, fetchedAt }

const _cache = new Map(); // url → {ts, payload}
const TTL_MS = 30 * 60 * 1000; // 30 min

const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Convertit une chaîne "74,82" ou "1.234,56" en nombre 74.82 / 1234.56
function parsePrice(str){
  if(!str) return null;
  // Cardmarket FR : virgule décimale, point milliers
  const clean = str.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(clean);
  return (isFinite(n) && n > 0) ? n : null;
}

// Extrait un prix associé à un label sur la page produit
// Cardmarket affiche : <dt>Label</dt><dd>X,XX €</dd>
function extractByLabel(html, labels){
  for(const label of labels){
    // 1) Format <dt>Label</dt> immédiatement suivi de <dd>prix</dd>
    const re1 = new RegExp(`<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([^<]*)</dd>`, 'i');
    const m1 = html.match(re1);
    if(m1){
      const price = parsePrice(m1[1].replace('€','').trim());
      if(price != null) return price;
    }
    // 2) Format générique label … XX,XX €
    const re2 = new RegExp(`${label}[\\s\\S]{0,200}?([\\d.,]+)\\s*€`, 'i');
    const m2 = html.match(re2);
    if(m2){
      const price = parsePrice(m2[1]);
      if(price != null) return price;
    }
  }
  return null;
}

async function scrapeCardmarket(url){
  const res = await fetch(url, {
    headers: {
      'User-Agent': REAL_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1'
    },
    redirect: 'follow'
  });

  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new Error(`Cardmarket HTTP ${res.status} : ${body.slice(0,150)}`);
  }
  const html = await res.text();

  // Détection blocage Cloudflare/anti-bot
  if(/just a moment|attention required|cf-browser-verification/i.test(html)){
    throw new Error('Bloqué par Cloudflare (page de challenge)');
  }

  const prices = {
    trend: extractByLabel(html, ['Tendance des prix', 'Price Trend', 'Preis-Trend']),
    avg30: extractByLabel(html, ['Prix moyen 30 jours', '30-days average price', '30-Tage-Durchschnittspreis']),
    avg7:  extractByLabel(html, ['Prix moyen 7 jours', '7-days average price', '7-Tage-Durchschnittspreis']),
    avg1:  extractByLabel(html, ['Prix moyen 1 jour', '1-day average price', '1-Tag-Durchschnittspreis']),
    low:   extractByLabel(html, ['Disponible à partir de', 'De ', 'Available from', 'Verfügbar ab']),
  };

  return prices;
}

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }

  try{
    const url = (req.query && req.query.url) || '';
    if(!url || !/^https:\/\/www\.cardmarket\.com\//.test(url)){
      return res.status(400).json({ error: 'Paramètre `url` requis et doit pointer sur cardmarket.com' });
    }

    // Cache
    const cached = _cache.get(url);
    if(cached && (Date.now() - cached.ts) < TTL_MS){
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached.payload);
    }

    const prices = await scrapeCardmarket(url);

    // Vérification minimale : au moins trend OU avg30 doit être présent
    if(prices.trend == null && prices.avg30 == null){
      return res.status(502).json({
        error: 'Aucun prix extrait — Cardmarket a peut-être changé son HTML, ou la carte n\'existe pas',
        url,
        prices
      });
    }

    const payload = { url, prices, fetchedAt: new Date().toISOString() };
    _cache.set(url, { ts: Date.now(), payload });
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch(e){
    console.error('cm-price error:', e);
    return res.status(500).json({
      error: e.message || 'Erreur interne',
      stack: (e.stack || '').split('\n').slice(0,4).join(' | ')
    });
  }
};
