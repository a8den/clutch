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
- **Back Market** — primary buyback marketplace
- **SellCell** — price comparison aggregator
- **Logic**: takes the LOWER of the two prices to protect margin
- **Filter**: drops anything under $50 payout
- **Schedule**: daily at 6:00am ET
