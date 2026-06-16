// Serverless function : récupère les ventes eBay récentes pour une recherche
// Usage côté front : fetch('/api/ebay-sold?q=Dracaufeu+ex+199/191')
// Cache 1h via header Cache-Control (Vercel CDN)

export default async function handler(req, res) {
  const { q } = req.query || {};
  if (!q || typeof q !== 'string' || q.trim().length < 2) {
    return res.status(400).json({ error: 'missing or invalid query param "q"' });
  }

  // CORS (au cas où, et utile pour test local)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const ebayUrl = `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent(q.trim())}&LH_Sold=1&LH_Complete=1&_ipg=60`;

  try {
    const r = await fetch(ebayUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    });

    if (!r.ok) {
      return res.status(502).json({ error: 'eBay returned ' + r.status, count: 0, prices: [] });
    }

    const html = await r.text();

    // Parse les vraies ventes (skip les "shop on ebay" et autres placeholders)
    // Structure typique : <li class="s-item ...">...<span class="s-item__price">EUR 25,00</span>...</li>
    // On découpe d'abord par <li class="s-item"> puis on extrait prix + titre + date dans chaque item
    const items = [];
    const itemBlocks = html.split(/<li[^>]*class="[^"]*s-item[^"]*"[^>]*>/i);

    for (let i = 1; i < itemBlocks.length; i++) {
      const block = itemBlocks[i];
      // Skip les items placeholder ("Shop on eBay")
      if (block.includes('s-item--placeholder') || block.includes('Shop on eBay')) continue;

      // Extract prix
      const priceMatch = block.match(/<span class="s-item__price"[^>]*>([\s\S]*?)<\/span>/i);
      if (!priceMatch) continue;
      const priceRaw = priceMatch[1].replace(/<[^>]+>/g, '').trim();
      // Format possible : "EUR 25,00" ou "EUR 25,00 à EUR 40,00" — on prend la 1re valeur (low)
      const priceNum = priceRaw.match(/([\d\s.,]+)/);
      if (!priceNum) continue;
      const price = parseFloat(priceNum[1].replace(/\s/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));
      if (!price || isNaN(price) || price <= 0 || price > 1000000) continue;

      // Extract titre
      const titleMatch = block.match(/<(?:span|div)[^>]*role="heading"[^>]*>([\s\S]*?)<\/(?:span|div)>/i)
                      || block.match(/<h3[^>]*class="s-item__title"[^>]*>([\s\S]*?)<\/h3>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      // Extract date (souvent dans .s-item__title--tagblock)
      const dateMatch = block.match(/Vendu le\s*([^<]+)/i) || block.match(/Sold[^<]*?(\d{1,2}\s+\w+[\s\d,]*)/i);
      const date = dateMatch ? dateMatch[1].trim() : '';

      // Extract shipping si présent (pour info uniquement)
      const shipMatch = block.match(/s-item__shipping[^>]*>([\s\S]*?)<\/span>/i);
      const shipping = shipMatch ? shipMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      items.push({ price, title, date, shipping });

      if (items.length >= 30) break;
    }

    if (items.length === 0) {
      // Cache court (5min) en cas de vide pour pas marteler eBay
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.json({ count: 0, prices: [], median: null, last: null, avg: null, ebayUrl });
    }

    // Stats
    const prices = items.map(i => i.price);
    const sorted = [...prices].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? +((sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2).toFixed(2)
      : sorted[Math.floor(sorted.length/2)];
    const avg = +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const last = items[0]; // 1er listing = vente la + récente sur eBay sold

    // Cache 1h côté Vercel CDN (réduit charges sur eBay + boost perf)
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

    return res.json({
      count: items.length,
      median,
      avg,
      min,
      max,
      last: { price: last.price, title: last.title, date: last.date },
      prices: prices.slice(0, 10),
      items: items.slice(0, 5),
      ebayUrl
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || String(e), count: 0, prices: [] });
  }
}
