// api/sync-lorcanajson.js
// Endpoint Vercel serverless : sync LorcanaJSON (FR) -> Supabase
// Déclenché par cron Vercel 1x/semaine (dimanche nuit)
// Protégé par CRON_SECRET (header Authorization: Bearer <secret>)
//
// Pas de dépendance npm : utilise fetch natif vers l'API REST Supabase.

const LORCANAJSON_URL = 'https://lorcanajson.org/files/current/fr/allCards.json';
const LANGUAGE = 'fr';
const BATCH_SIZE = 500;

module.exports = async (req, res) => {
  // Auth : header Authorization OU query ?secret=
  const authHeader = req.headers.authorization || '';
  const providedSecret = authHeader.replace(/^Bearer\s+/i, '') || req.query.secret;
  if (providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'missing supabase env vars' });
  }

  const startedAt = Date.now();
  let totalProcessed = 0;
  let totalUpserted = 0;
  let skippedNoNumber = 0;
  let skippedNoSetCode = 0;

  try {
    // 1. Fetch LorcanaJSON
    const resp = await fetch(LORCANAJSON_URL);
    if (!resp.ok) {
      throw new Error(`LorcanaJSON fetch failed: ${resp.status}`);
    }
    const data = await resp.json();
    const cards = data.cards || [];
    totalProcessed = cards.length;

    // 2. Mapper -> rows Supabase
    const rows = [];
    for (const c of cards) {
      if (!c.setCode) { skippedNoSetCode++; continue; }
      if (c.number === undefined || c.number === null) { skippedNoNumber++; continue; }

      const ext = c.externalLinks || {};
      rows.push({
        lorcanajson_id: c.id,
        set_code: String(c.setCode),
        card_number: String(c.number),
        full_name: c.fullName || c.name || '',
        rarity: c.rarity || null,
        cardmarket_url: ext.cardmarketUrl || null,
        cardmarket_id: ext.cardmarketId || null,
        tcgplayer_url: ext.tcgPlayerUrl || null,
        tcgplayer_id: ext.tcgPlayerId || null,
        language: LANGUAGE,
        updated_at: new Date().toISOString(),
      });
    }

    // 3. Upsert par batches via API REST Supabase
    const upsertUrl = `${supabaseUrl}/rest/v1/lorcana_cardmarket_mapping?on_conflict=set_code,card_number,language`;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const upsertResp = await fetch(upsertUrl, {
        method: 'POST',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(batch),
      });
      if (!upsertResp.ok) {
        const errText = await upsertResp.text();
        throw new Error(`Upsert batch ${i} failed: ${upsertResp.status} ${errText}`);
      }
      totalUpserted += batch.length;
    }

    const durationMs = Date.now() - startedAt;
    return res.status(200).json({
      ok: true,
      language: LANGUAGE,
      processed: totalProcessed,
      upserted: totalUpserted,
      skipped_no_setcode: skippedNoSetCode,
      skipped_no_number: skippedNoNumber,
      duration_ms: durationMs,
    });
  } catch (err) {
    console.error('sync-lorcanajson error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message,
      processed: totalProcessed,
      upserted: totalUpserted,
    });
  }
};
