// api/pokemon-price-rt.js
//
// Cotes Pokémon en temps réel via TCGGO (Cardmarket EU rafraîchi plusieurs fois/jour).
// Remplace les données obsolètes de pokemontcg.io (souvent plusieurs mois de retard).
//
// Variables d'environnement requises sur Vercel :
//   RAPIDAPI_KEY  = ta clé X-RapidAPI-Key (depuis rapidapi.com)
//
// Usage côté client :
//   GET /api/pokemon-price-rt?tcgid=sv3pt5-4
//   GET /api/pokemon-price-rt?cardmarket_id=691949

export default async function handler(req, res) {
  // CORS (utile en local / preview)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { tcgid, cardmarket_id } = req.query;
  if (!tcgid && !cardmarket_id) {
    return res.status(400).json({ error: 'tcgid or cardmarket_id required' });
  }

  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    return res.status(500).json({ error: 'RAPIDAPI_KEY not configured' });
  }

  const host = 'pokemon-tcg-api.p.rapidapi.com';
  const params = new URLSearchParams();
  if (tcgid) params.set('tcgid', String(tcgid));
  if (cardmarket_id) params.set('cardmarket_id', String(cardmarket_id));
  params.set('per_page', '1');

  try {
    const upstream = await fetch(`https://${host}/cards?${params.toString()}`, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'upstream error',
        status: upstream.status,
      });
    }

    const data = await upstream.json();
    const card = data && data.data && data.data[0];
    if (!card) return res.status(404).json({ error: 'card not found' });

    const cm = (card.prices && card.prices.cardmarket) || {};
    const out = {
      source: 'TCGGO/Cardmarket',
      currency: cm.currency || 'EUR',
      prices: {
        // 7d_average ≈ Cardmarket Trend (Cardmarket ne renvoie pas un "trend" pur,
        // 7d_average est la valeur la plus proche du Trend Price affiché sur le site)
        trend: cm['7d_average'] != null ? cm['7d_average'] : null,
        low: cm.lowest_near_mint != null ? cm.lowest_near_mint : null,
        low_fr: cm.lowest_near_mint_FR != null ? cm.lowest_near_mint_FR : null,
        avg7: cm['7d_average'] != null ? cm['7d_average'] : null,
        avg30: cm['30d_average'] != null ? cm['30d_average'] : null,
      },
      graded: cm.graded || null,
      cardmarket_id: card.cardmarket_id || null,
      tcgid: card.tcgid || null,
    };

    // Cache CDN 6h + stale-while-revalidate 24h pour économiser le quota RapidAPI
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: 'fetch failed', message: String(e) });
  }
}
