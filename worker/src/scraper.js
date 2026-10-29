/**
 * Clutch Price Scraper
 * Cloudflare Worker — runs on cron schedule (daily 6am ET)
 *
 * Sources: Back Market Trade-in API + SellCell
 * Strategy: take the LOWER of the two prices to protect margin
 * Filter: drop anything with a payout under MIN_PAYOUT_CENTS
 */

const MIN_PAYOUT_CENTS = 5000;          // $50.00 minimum offer
const SHIP_TO_US_THRESHOLD_CENTS = 20000; // $200.00 client payout — route to Clutch first for inspection

// ─── Back Market trade-in API ────────────────────────────────────────────────
// Back Market has a public trade-in/buyback flow. We hit their product catalog
// endpoint which returns buyback pricing without auth.
async function fetchBackMarket() {
  const results = [];

  // Back Market buyback catalog — paginated
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://www.backmarket.com/bm/buyback/api/products?page=${page}&page_size=100`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-US',
        'User-Agent': 'Mozilla/5.0 (compatible; ClutchPricer/1.0)'
      }
    });

    if (!res.ok) break;

    const data = await res.json();
    const items = data.results || data.products || [];
    if (items.length === 0) { hasMore = false; break; }

    for (const item of items) {
      // Back Market returns grades: 'excellent', 'good', 'fair'
      const grades = item.grades || item.conditions || [];
      for (const grade of grades) {
        const priceCents = Math.round((grade.price || grade.amount || 0) * 100);
        if (priceCents < MIN_PAYOUT_CENTS) continue;

        results.push({
          model: item.title || item.name,
          brand: item.brand || deriveBrand(item.title),
          storage: extractStorage(item.title),
          condition: normalizeCondition(grade.label || grade.grade),
          price_cents: priceCents,
          source: 'backmarket'
        });
      }
    }

    // Check if there's a next page
    hasMore = !!(data.next || (data.total > page * 100));
    page++;

    // Safety cap — don't loop forever
    if (page > 30) break;

    // Be polite to their servers
    await sleep(500);
  }

  return results;
}

// ─── SellCell scraper ────────────────────────────────────────────────────────
async function fetchSellCell() {
  const results = [];

  // SellCell comparison page returns JSON data we can parse
  const brands = ['apple', 'samsung'];

  for (const brand of brands) {
    const url = `https://www.sellcell.com/sell-${brand}-phones/`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; ClutchPricer/1.0)'
      }
    });

    if (!res.ok) continue;

    const html = await res.text();

    // SellCell embeds price data as JSON in a script tag
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});<\/script>/s)
      || html.match(/var productData\s*=\s*(\[.+?\]);/s);

    if (!match) continue;

    try {
      const data = JSON.parse(match[1]);
      const products = extractSellCellProducts(data);

      for (const p of products) {
        if (p.price_cents < MIN_PAYOUT_CENTS) continue;
        results.push({ ...p, source: 'sellcell' });
      }
    } catch (e) {
      console.error(`SellCell parse error for ${brand}:`, e.message);
    }

    await sleep(300);
  }

  return results;
}

function extractSellCellProducts(data) {
  const out = [];
  // Handle various SellCell data shapes
  const items = Array.isArray(data) ? data
    : data.products || data.phones || data.devices || [];

  for (const item of items) {
    const conditions = item.conditions || item.grades || [];
    for (const c of conditions) {
      const price = c.price || c.amount || c.value || 0;
      out.push({
        model: item.name || item.title,
        brand: item.brand || deriveBrand(item.name),
        storage: extractStorage(item.name),
        condition: normalizeCondition(c.name || c.label),
        price_cents: Math.round(price * 100)
      });
    }
  }
  return out;
}

// ─── ROI multipliers by device generation + condition ────────────────────────
// Formula: offer_price = exit_price / multiplier
// Generations:
//   flagship — iPhone 15+, Galaxy S24+, iPad Pro M2+, MacBook M2+, PS5, Xbox Series X/S, Switch OLED
//   midtier  — iPhone 12-14, Galaxy S21-S23, iPad Air/mini 5th gen+, MacBook M1, PS4 Pro, Xbox One X/S, Switch V2
//   old      — iPhone 11 and under, Galaxy S20 and under, older iPads/MacBooks, PS4 base, Xbox One base, Switch V1
//
// Condition gaps kept narrow (2-4 pts) so a grade revision doesn't shock the seller.
// Consoles floor at /1.30 regardless of generation.

const ROI_MULTIPLIERS = {
  flagship: { Excellent: 1.20, Good: 1.23, Fair: 1.27 },
  midtier:  { Excellent: 1.25, Good: 1.28, Fair: 1.32 },
  old:      { Excellent: 1.30, Good: 1.33, Fair: 1.38 },
  console:  { Excellent: 1.30, Good: 1.33, Fair: 1.38 }, // floor at 1.30 always
};

// Classify a device model into a generation tier
function deviceGeneration(model, deviceType) {
  if (!model) return 'midtier';
  const m = model.toLowerCase();

  if (deviceType === 'console') return 'console';

  // iPhones
  if (m.includes('iphone')) {
    const num = parseInt((m.match(/iphone\s*(\d+)/i) || [])[1] || '0');
    if (num >= 15) return 'flagship';
    if (num >= 12) return 'midtier';
    return 'old';
  }

  // Samsung Galaxy S
  if (m.includes('galaxy s') || m.includes('samsung s')) {
    const num = parseInt((m.match(/s(\d+)/i) || [])[1] || '0');
    if (num >= 24) return 'flagship';
    if (num >= 21) return 'midtier';
    return 'old';
  }

  // iPad
  if (m.includes('ipad pro')) {
    if (m.includes('m2') || m.includes('m3') || m.includes('m4')) return 'flagship';
    return 'midtier';
  }
  if (m.includes('ipad air') || m.includes('ipad mini')) {
    const num = parseInt((m.match(/(\d+)(?:th|st|nd|rd)/i) || [])[1] || '0');
    if (num >= 5) return 'midtier';
    return 'old';
  }
  if (m.includes('ipad')) return 'old';

  // MacBook
  if (m.includes('macbook')) {
    if (m.includes('m2') || m.includes('m3') || m.includes('m4')) return 'flagship';
    if (m.includes('m1')) return 'midtier';
    return 'old';
  }

  return 'midtier'; // safe default
}

function getMultiplier(deviceType, model, condition) {
  const gen = deviceGeneration(model, deviceType);
  const table = ROI_MULTIPLIERS[gen] || ROI_MULTIPLIERS.midtier;
  return table[condition] || table.Good;
}

// ─── Merge + take HIGHER price (Back Market preferred) ───────────────────────
function mergePrices(backMarketItems, sellCellItems) {
  const map = new Map();

  const key = (item) =>
    `${item.model}||${item.storage || ''}||${item.condition}`.toLowerCase();

  for (const item of backMarketItems) {
    const k = key(item);
    if (!map.has(k)) map.set(k, { ...item, backmarket_price: item.price_cents, sellcell_price: null });
    else map.get(k).backmarket_price = item.price_cents;
  }

  for (const item of sellCellItems) {
    const k = key(item);
    if (!map.has(k)) map.set(k, { ...item, sellcell_price: item.price_cents, backmarket_price: null });
    else map.get(k).sellcell_price = item.price_cents;
  }

  const merged = [];
  for (const [, item] of map) {
    // Prefer Back Market price; fall back to SellCell
    const exitPrice = item.backmarket_price || item.sellcell_price;
    if (!exitPrice || exitPrice < MIN_PAYOUT_CENTS) continue;

    // Flag large variance for awareness (>35% gap between sources)
    const hasBothSources = item.backmarket_price && item.sellcell_price;
    const variance = hasBothSources
      ? Math.abs(item.backmarket_price - item.sellcell_price) / Math.max(item.backmarket_price, item.sellcell_price)
      : 0;
    const flagged = variance > 0.35;

    // Calculate offer using generation-tiered ROI formula: offer = exit_price / multiplier
    const deviceType = deriveDeviceType(item.model, item.brand);
    const multiplier = getMultiplier(deviceType, item.model, item.condition);
    const offer = Math.round(exitPrice / multiplier);

    if (offer < MIN_PAYOUT_CENTS) continue;

    // Routing: client payouts at/above $200 go to Clutch first for inspection + regrading
    const routing = offer >= SHIP_TO_US_THRESHOLD_CENTS ? 'ship_to_clutch' : 'ship_direct';

    merged.push({
      model: item.model,
      brand: item.brand,
      storage: item.storage,
      condition: item.condition,
      device_type: deviceType,
      sellcell_price: item.sellcell_price,
      backmarket_price: item.backmarket_price,
      offer_price: offer,
      routing,           // 'ship_to_clutch' | 'ship_direct'
      flagged: flagged ? 1 : 0
    });
  }

  return merged;
}

// ─── Write to D1 ─────────────────────────────────────────────────────────────
async function writeToD1(db, items) {
  const now = new Date().toISOString();

  // Clear old prices and rewrite fresh
  await db.prepare('DELETE FROM prices').run();

  const stmt = db.prepare(`
    INSERT INTO prices
      (device_type, brand, model, storage, condition, sellcell_price, backmarket_price, offer_price, routing, flagged, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Batch in chunks of 100
  const chunks = chunkArray(items, 100);
  for (const chunk of chunks) {
    await db.batch(
      chunk.map(item => stmt.bind(
        item.device_type,
        item.brand,
        item.model,
        item.storage || null,
        item.condition,
        item.sellcell_price || null,
        item.backmarket_price || null,
        item.offer_price,
        item.routing || 'ship_direct',
        item.flagged || 0,
        now
      ))
    );
  }

  await db.prepare(`UPDATE config SET value = ? WHERE key = 'last_scrape'`)
    .bind(now).run();

  return items.length;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeCondition(raw) {
  if (!raw) return 'Good';
  const s = raw.toLowerCase();
  if (s.includes('excel') || s.includes('mint') || s.includes('like new')) return 'Excellent';
  if (s.includes('good') || s.includes('grade b')) return 'Good';
  if (s.includes('fair') || s.includes('poor') || s.includes('grade c')) return 'Fair';
  return 'Good';
}

function extractStorage(title) {
  if (!title) return null;
  const m = title.match(/(\d+)\s*(GB|TB)/i);
  if (!m) return null;
  return m[2].toUpperCase() === 'TB' ? `${m[1]}TB` : `${m[1]}GB`;
}

function deriveBrand(title) {
  if (!title) return 'Unknown';
  const t = title.toLowerCase();
  if (t.includes('iphone') || t.includes('ipad') || t.includes('macbook') || t.includes('apple watch') || t.includes('airpods')) return 'Apple';
  if (t.includes('samsung') || t.includes('galaxy')) return 'Samsung';
  if (t.includes('playstation') || t.includes('ps4') || t.includes('ps5')) return 'Sony';
  if (t.includes('xbox')) return 'Microsoft';
  if (t.includes('nintendo') || t.includes('switch')) return 'Nintendo';
  return 'Other';
}

function deriveDeviceType(model, brand) {
  if (!model) return 'other';
  const m = model.toLowerCase();
  if (m.includes('iphone')) return 'iphone';
  if (m.includes('ipad')) return 'ipad';
  if (m.includes('macbook')) return 'macbook';
  if (m.includes('apple watch')) return 'watch';
  if (m.includes('airpods')) return 'airpods';
  if (m.includes('galaxy') || (brand === 'Samsung')) return 'samsung';
  if (m.includes('ps4') || m.includes('ps5') || m.includes('playstation') || m.includes('xbox') || m.includes('switch') || m.includes('nintendo')) return 'console';
  return 'other';
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Worker entry point ───────────────────────────────────────────────────────
export default {
  // Cron trigger — runs daily at 6am ET (10:00 UTC)
  async scheduled(event, env, ctx) {
    console.log('Clutch price scrape starting...');
    try {
      const [backMarketItems, sellCellItems] = await Promise.allSettled([
        fetchBackMarket(),
        fetchSellCell()
      ]);

      const bm = backMarketItems.status === 'fulfilled' ? backMarketItems.value : [];
      const sc = sellCellItems.status === 'fulfilled' ? sellCellItems.value : [];

      console.log(`Back Market: ${bm.length} items, SellCell: ${sc.length} items`);

      const merged = mergePrices(bm, sc);
      console.log(`Merged: ${merged.length} items above $${MIN_PAYOUT_CENTS / 100} threshold`);

      const count = await writeToD1(env.DB, merged);
      console.log(`Wrote ${count} prices to D1`);
    } catch (err) {
      console.error('Scrape failed:', err);
      // Don't throw — let the old prices stay in D1
    }
  },

  // HTTP endpoint
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const isAdmin = request.headers.get('X-Admin-Pass') === 'cashout';

    // ── GET /inventory ── (public)
    if (url.pathname === '/inventory' && request.method === 'GET') {
      const raw = await env.CLUTCH_KV.get('inventory');
      const inventory = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify({ inventory }), { headers: corsHeaders });
    }

    // ── POST /inventory ── (admin only — full replace)
    if (url.pathname === '/inventory' && request.method === 'POST') {
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const body = await request.json();
      const inventory = body.inventory || [];
      await env.CLUTCH_KV.put('inventory', JSON.stringify(inventory));
      return new Response(JSON.stringify({ ok: true, count: inventory.length }), { headers: corsHeaders });
    }

    // ── POST /lead ──
    if (url.pathname === '/lead' && request.method === 'POST') {
      const lead = await request.json();
      const raw = await env.CLUTCH_KV.get('leads');
      const leads = raw ? JSON.parse(raw) : [];
      leads.unshift(lead);
      await env.CLUTCH_KV.put('leads', JSON.stringify(leads));
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    // ── GET /leads ── (admin only)
    if (url.pathname === '/leads' && request.method === 'GET') {
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const raw = await env.CLUTCH_KV.get('leads');
      const leads = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify({ leads }), { headers: corsHeaders });
    }

    // ── PATCH /lead/:id ── (admin only — update status)
    if (url.pathname.startsWith('/lead/') && request.method === 'PATCH') {
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const id = url.pathname.split('/')[2];
      const { status } = await request.json();
      const raw = await env.CLUTCH_KV.get('leads');
      const leads = raw ? JSON.parse(raw) : [];
      const lead = leads.find(l => l.id === id);
      if (lead) lead.status = status;
      await env.CLUTCH_KV.put('leads', JSON.stringify(leads));
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    // ── GET /prices ── (KV cache — falls back to empty)
    if (url.pathname === '/prices' && request.method === 'GET') {
      const raw = await env.CLUTCH_KV.get('prices');
      const prices = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify({ prices }), { headers: corsHeaders });
    }

    // ── POST /prices ── (admin only — store price overrides)
    if (url.pathname === '/prices' && request.method === 'POST') {
      if (!isAdmin) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      const body = await request.json();
      await env.CLUTCH_KV.put('prices', JSON.stringify(body.prices || []));
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    // ── GET /status ──
    if (url.pathname === '/status') {
      const [inv, leads, prices] = await Promise.all([
        env.CLUTCH_KV.get('inventory'),
        env.CLUTCH_KV.get('leads'),
        env.CLUTCH_KV.get('prices'),
      ]);
      return new Response(JSON.stringify({
        inventory: inv ? JSON.parse(inv).length : 0,
        leads: leads ? JSON.parse(leads).length : 0,
        prices: prices ? JSON.parse(prices).length : 0,
      }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
  }
};
