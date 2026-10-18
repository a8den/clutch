# Clutch Cashout

Electronics buyback site for Syracuse & Binghamton NY.

## Structure

```
clutch/
  site/          ← static site, deployed via Cloudflare Pages
  worker/        ← price scraper, deployed as Cloudflare Worker
  schema.sql     ← D1 database schema
```

## Setup (one-time)

### 1. Create D1 database
```bash
cd worker
npm install
npx wrangler d1 create clutch-db
# Copy the database_id from the output into wrangler.toml
npx wrangler d1 execute clutch-db --remote --file=../schema.sql
```

### 2. Set admin secret
```bash
npx wrangler secret put ADMIN_SECRET
# Enter any strong password — this protects the manual /scrape trigger
```

### 3. Deploy Worker
```bash
npx wrangler deploy
```

### 4. Deploy Site (Cloudflare Pages)
- Go to Cloudflare Dashboard → Pages → Create a project
- Connect to GitHub repo → set build output directory to `site`
- Add custom domain: `clutch.mancinimerchandising.com`

## Worker API

| Endpoint | Method | Description |
|---|---|---|
| `/prices?type=iphone` | GET | Get all prices for a device type |
| `/prices?model=iPhone+15+Pro&storage=256GB&condition=Good` | GET | Get specific price |
| `/models?type=iphone` | GET | Get distinct model list |
| `/status` | GET | Last scrape time + price count |
| `/scrape` | POST | Manual scrape trigger (requires X-Admin-Secret header) |

## Price Sources
- **Back Market** — primary buyback marketplace (preferred price)
- **SellCell** — price comparison aggregator (fallback)
- **Logic**: takes Back Market price preferentially; flags >35% variance between sources
- **ROI formula**: `offer = exit_price / multiplier` — tiered by device generation:
  - Flagship (iPhone 15+, S24+, PS5, Series X): Excellent /1.20, Good /1.23, Fair /1.27
  - Mid-tier (iPhone 12-14, S21-S23, PS4 Pro): Excellent /1.25, Good /1.28, Fair /1.32
  - Old (iPhone 11-, S20-, PS4 base): Excellent /1.30, Good /1.33, Fair /1.38
- **Routing**: offers ≥$200 → `ship_to_clutch` (inspect first); under $200 → `ship_direct`
- **Filter**: drops anything under $50 offer
- **Schedule**: daily at 6:00am ET
