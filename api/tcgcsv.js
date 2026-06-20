// /api/tcgcsv.js — Proxy + filtre des produits scellés TCGplayer via tcgcsv.com
// Endpoints supportés :
//   GET /api/tcgcsv?action=sealed&setName=Surging+Sparks
//     → renvoie { groupId, groupName, products: [{productId, name, type, imageUrl, prices:{market,low,mid,high}, url}] }
//   GET /api/tcgcsv?action=groups   (debug, liste tous les groupes Pokémon TCGplayer)

// Cache mémoire (réinitialisé à chaque cold start, ~heures)
let _groupsCache = null;
let _groupsCacheTs = 0;
const GROUPS_TTL_MS = 6 * 3600 * 1000; // 6h

// Cache produits par group (TTL 1h)
const _productsCache = new Map(); // groupId -> {ts, payload}
const PRODUCTS_TTL_MS = 60 * 60 * 1000;

const POKEMON_CATEGORY_ID = 3;
const BASE = `https://tcgcsv.com/tcgplayer/${POKEMON_CATEGORY_ID}`;

// ───────────────────────────────────────────────────────────
// Helper fetch — TCGCSV exige un User-Agent custom sinon HTTP 401
// Doc: https://tcgcsv.com/docs ("Requests with generic or missing User-Agents may be blocked")
// ───────────────────────────────────────────────────────────
const TCGCSV_UA = 'Soridex/1.0 (+https://soridex.fr)';

async function fetchTCG(url){
  return fetch(url, {
    headers: {
      'User-Agent': TCGCSV_UA,
      'Accept': 'application/json'
    }
  });
}

// ───────────────────────────────────────────────────────────
// Normalisation pour matcher les noms de set
// ───────────────────────────────────────────────────────────
function norm(s){
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Variantes de préfixes/suffixes TCGplayer pour matcher pokemontcg.io
// TCGplayer nomme souvent : "SV: Surging Sparks", "Scarlet & Violet: Surging Sparks", etc.
function candidateNames(name){
  const n = norm(name);
  const variants = new Set([n]);
  // Retirer préfixes de série courants
  const prefixes = [
    'sv ', 'scarlet and violet ', 'sword and shield ', 'swsh ',
    'sun and moon ', 'sm ', 'xy ', 'black and white ', 'bw ',
    'heartgold and soulsilver ', 'hgss ', 'diamond and pearl ', 'dp ',
    'ex ', 'platinum ', 'mega evolution ', 'me '
  ];
  for(const p of prefixes){
    if(n.startsWith(p)) variants.add(n.slice(p.length));
  }
  return Array.from(variants);
}

// ───────────────────────────────────────────────────────────
// Fetch groups (tous les sets Pokémon TCGplayer)
// ───────────────────────────────────────────────────────────
async function fetchGroups(){
  if(_groupsCache && (Date.now() - _groupsCacheTs) < GROUPS_TTL_MS){
    return _groupsCache;
  }
  const res = await fetchTCG(`${BASE}/groups`);
  if(!res.ok) throw new Error(`TCGCSV groups HTTP ${res.status}`);
  const data = await res.json();
  _groupsCache = data.results || [];
  _groupsCacheTs = Date.now();
  return _groupsCache;
}

// Trouve le groupId qui matche le mieux le nom du set
function findGroupId(groups, setName){
  const candidates = candidateNames(setName);
  // Match exact d'abord
  for(const c of candidates){
    const exact = groups.find(g => norm(g.name) === c);
    if(exact) return exact;
  }
  // Match par "endsWith" (TCGplayer ajoute souvent un préfixe de série)
  for(const c of candidates){
    const ends = groups.find(g => {
      const gn = norm(g.name);
      return gn.endsWith(' ' + c) || gn.endsWith(': ' + c);
    });
    if(ends) return ends;
  }
  // Match par "contains" (dernier recours)
  for(const c of candidates){
    if(c.length < 4) continue; // évite les faux positifs sur 3 lettres
    const contains = groups.find(g => norm(g.name).includes(c));
    if(contains) return contains;
  }
  return null;
}

// ───────────────────────────────────────────────────────────
// Filtre sealed : produits TCGplayer sans "Number" dans extendedData
// = pas un single (cartes ont toujours un Number)
// On exclut aussi les codes en ligne et accessoires hors set
// ───────────────────────────────────────────────────────────
function isSealedProduct(p){
  const ext = p.extendedData || [];
  const hasNumber = ext.some(e => e.name === 'Number');
  if(hasNumber) return false; // c'est un single

  const name = (p.name || '').toLowerCase();
  // Exclure codes online et goodies hors-set
  if(/online code|code card/.test(name)) return false;
  return true;
}

// Identifie le type de produit scellé d'après son nom
function classifySealed(name){
  const n = (name || '').toLowerCase();
  if(/booster box|booster display|36[- ]?pack/.test(n)) return 'Display';
  if(/elite trainer box|\betb\b/.test(n))               return 'ETB';
  if(/booster bundle|6[- ]?pack/.test(n))               return 'Bundle';
  if(/booster pack/.test(n))                            return 'Booster';
  if(/build.{0,3}battle/.test(n))                       return 'Build & Battle';
  if(/theme deck|preconstructed|deck box/.test(n))      return 'Deck';
  if(/starter deck|battle deck|league battle deck/.test(n)) return 'Deck';
  if(/blister|3[- ]?pack/.test(n))                      return 'Blister';
  if(/tin\b/.test(n))                                   return 'Tin';
  if(/collection box|premium collection|ultra.?premium|special collection/.test(n)) return 'Coffret';
  if(/collection/.test(n))                              return 'Coffret';
  if(/bundle/.test(n))                                  return 'Bundle';
  if(/box\b/.test(n))                                   return 'Coffret';
  if(/pin\b/.test(n))                                   return 'Pin';
  return 'Autre';
}

// Map productId → prix
function buildPriceMap(prices){
  const m = new Map();
  for(const p of (prices || [])){
    if(!p || p.productId == null) continue;
    const existing = m.get(p.productId);
    // Préfère le subTypeName "Normal" / null
    if(!existing || p.subTypeName === 'Normal' || !p.subTypeName){
      m.set(p.productId, {
        market: p.marketPrice ?? null,
        low:    p.lowPrice ?? null,
        mid:    p.midPrice ?? null,
        high:   p.highPrice ?? null,
        direct: p.directLowPrice ?? null,
      });
    }
  }
  return m;
}

// ───────────────────────────────────────────────────────────
// Récupère et filtre les produits sealed d'un groupe
// ───────────────────────────────────────────────────────────
async function fetchSealedForGroup(groupId){
  const cached = _productsCache.get(groupId);
  if(cached && (Date.now() - cached.ts) < PRODUCTS_TTL_MS){
    return cached.payload;
  }

  const [prodRes, priceRes] = await Promise.all([
    fetchTCG(`${BASE}/${groupId}/products`),
    fetchTCG(`${BASE}/${groupId}/prices`)
  ]);
  if(!prodRes.ok) throw new Error(`TCGCSV products HTTP ${prodRes.status}`);

  const prodData  = await prodRes.json();
  const priceData = priceRes.ok ? await priceRes.json() : {results: []};

  const priceMap = buildPriceMap(priceData.results || []);
  const products = (prodData.results || [])
    .filter(isSealedProduct)
    .map(p => ({
      productId: p.productId,
      name:      p.name,
      type:      classifySealed(p.name),
      imageUrl:  p.imageUrl || null,
      url:       p.url || `https://www.tcgplayer.com/product/${p.productId}`,
      prices:    priceMap.get(p.productId) || null,
    }))
    // Tri : par type puis par prix décroissant
    .sort((a,b) => {
      const order = ['Display','ETB','Coffret','Bundle','Booster','Build & Battle','Blister','Tin','Deck','Pin','Autre'];
      const ai = order.indexOf(a.type), bi = order.indexOf(b.type);
      if(ai !== bi) return ai - bi;
      const ap = (a.prices && a.prices.market) || 0;
      const bp = (b.prices && b.prices.market) || 0;
      return bp - ap;
    });

  const payload = { products };
  _productsCache.set(groupId, { ts: Date.now(), payload });
  return payload;
}

// ───────────────────────────────────────────────────────────
// Handler Vercel
// ───────────────────────────────────────────────────────────
export default async function handler(req, res){
  // CORS (Vercel sert l'app sur le même domaine mais on est large)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }

  try{
    const { action = 'sealed', setName, groupId } = req.query || {};

    if(action === 'groups'){
      const groups = await fetchGroups();
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
      return res.status(200).json({ count: groups.length, groups });
    }

    if(action === 'sealed'){
      let gid = groupId;
      let groupName = null;

      if(!gid){
        if(!setName){
          return res.status(400).json({ error: 'setName ou groupId requis' });
        }
        const groups = await fetchGroups();
        const match = findGroupId(groups, setName);
        if(!match){
          return res.status(404).json({ error: 'Set introuvable côté TCGplayer', setName });
        }
        gid = match.groupId;
        groupName = match.name;
      }

      const { products } = await fetchSealedForGroup(gid);
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
      return res.status(200).json({
        groupId: gid,
        groupName,
        count: products.length,
        products
      });
    }

    return res.status(400).json({ error: 'action inconnue', action });
  } catch(e){
    console.error('tcgcsv handler error:', e);
    return res.status(500).json({ error: e.message || 'Erreur interne' });
  }
}
