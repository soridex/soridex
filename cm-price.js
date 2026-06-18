// api/cm-price.js
// Vercel serverless function : scrape Cardmarket pour récupérer les cotes fraîches
// Usage : GET /api/cm-price?url=https://www.cardmarket.com/fr/Pokemon/Products/Singles/...

export default async function handler(req, res) {
  // CORS (au cas où l'app est appelée depuis un autre domaine)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400'); // cache 1h sur Vercel edge

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing ?url parameter' });
  }

  // Validation : on n'accepte QUE des URLs Cardmarket pour éviter d'être utilisé comme proxy
  if (!/^https:\/\/(www\.)?cardmarket\.com\/(fr|en|de|es|it)\/(Pokemon|Magic|Lorcana|YuGiOh|OnePiece)\/Products\/(Singles|Boosters)\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid Cardmarket URL' });
  }

  // Force la version française pour avoir les labels FR
  let targetUrl = url;
  if (!/\/fr\//.test(targetUrl)) {
    targetUrl = targetUrl.replace(/\/(en|de|es|it)\//, '/fr/');
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      return res.status(502).json({
        error: 'Cardmarket fetch failed',
        status: response.status,
        statusText: response.statusText
      });
    }

    const html = await response.text();

    // Helper : parse "361,96 €" -> 361.96
    const parseEuro = (str) => {
      if (!str) return null;
      // Enlève les espaces (incl. nbsp), garde chiffres + virgule/point
      const cleaned = str.replace(/[\s\u00a0]/g, '').replace(/\./g, '').replace(',', '.');
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    };

    // Extraction par label : Cardmarket utilise une structure type <dt>Label</dt><dd>Valeur</dd>
    // ou parfois des spans. On essaie plusieurs patterns.
    const extractByLabel = (labels) => {
      // labels = array de labels possibles (FR + EN)
      for (const label of labels) {
        // Pattern 1 : <dt>Label</dt><dd>123,45 €</dd>
        const p1 = new RegExp(`<dt[^>]*>\\s*${label}\\s*</dt>\\s*<dd[^>]*>\\s*([0-9.,\\s\\u00a0]+)\\s*€`, 'i');
        let m = html.match(p1);
        if (m) return parseEuro(m[1]);

        // Pattern 2 : Label suivi de la valeur dans un span/div proche (jusqu'à 300 chars)
        const p2 = new RegExp(`${label}[\\s\\S]{0,300}?([0-9]+[.,\\s\\u00a0][0-9]+)\\s*€`, 'i');
        m = html.match(p2);
        if (m) return parseEuro(m[1]);

        // Pattern 3 : Cellule de tableau <td>Label</td><td>123,45 €</td>
        const p3 = new RegExp(`<td[^>]*>\\s*${label}\\s*</td>\\s*<td[^>]*>\\s*([0-9.,\\s\\u00a0]+)\\s*€`, 'i');
        m = html.match(p3);
        if (m) return parseEuro(m[1]);
      }
      return null;
    };

    const prices = {
      // De / À partir de = Lowest available offer
      low:    extractByLabel(['À partir de', 'A partir de', 'De', 'From', 'Ab']),
      // Tendance = Price Trend
      trend:  extractByLabel(['Tendance des prix', 'Price Trend', 'Preis-Trend']),
      // Moyennes
      avg30:  extractByLabel(['Prix moyen 30 jours', '30-days average price', '30-Tage-Durchschnittspreis']),
      avg7:   extractByLabel(['Prix moyen 7 jours', '7-days average price', '7-Tage-Durchschnittspreis']),
      avg1:   extractByLabel(['Prix moyen 1 jour', '1-day average price', '1-Tag-Durchschnittspreis'])
    };

    // Nettoie les nulls
    const cleanPrices = {};
    let foundAny = false;
    for (const [k, v] of Object.entries(prices)) {
      if (v !== null && !isNaN(v) && v > 0) {
        cleanPrices[k] = v;
        foundAny = true;
      }
    }

    if (!foundAny) {
      return res.status(502).json({
        error: 'No prices found in page (parser may need update)',
        url: targetUrl,
        htmlLength: html.length,
        htmlSample: html.substring(0, 500)
      });
    }

    return res.status(200).json({
      prices: cleanPrices,
      url: targetUrl,
      scrapedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Cardmarket scrape error:', err);
    return res.status(500).json({
      error: err.message || 'Unknown error'
    });
  }
}
