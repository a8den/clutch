#!/bin/bash
# Clutch one-time setup script
# Run from the repo root: bash scripts/setup.sh

set -e

echo "=== Clutch Setup ==="
echo ""

# 1. Install worker deps
echo "→ Installing Worker dependencies..."
cd worker && npm install && cd ..

# 2. Create D1 database
echo ""
echo "→ Creating D1 database..."
DB_OUTPUT=$(cd worker && npx wrangler d1 create clutch-db 2>&1)
echo "$DB_OUTPUT"

# Extract database_id from output
DB_ID=$(echo "$DB_OUTPUT" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2)

if [ -n "$DB_ID" ]; then
  echo ""
  echo "→ Writing database_id to wrangler.toml..."
  sed -i "s/REPLACE_WITH_YOUR_D1_ID/$DB_ID/" worker/wrangler.toml
  echo "✓ database_id set to: $DB_ID"
else
  echo ""
  echo "⚠ Could not auto-detect database_id."
  echo "  Copy the database_id from above and paste it into worker/wrangler.toml"
  echo "  Replace: REPLACE_WITH_YOUR_D1_ID"
fi

# 3. Initialize schema
echo ""
echo "→ Initializing D1 schema..."
cd worker && npx wrangler d1 execute clutch-db --remote --file=../schema.sql && cd ..
echo "✓ Schema applied"

# 4. Set admin secret
echo ""
echo "→ Setting admin secret (you'll be prompted to enter a password)..."
cd worker && npx wrangler secret put ADMIN_SECRET && cd ..

# 5. Deploy worker
echo ""
echo "→ Deploying Worker to Cloudflare..."
cd worker && npx wrangler deploy && cd ..

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "1. Go to Cloudflare Dashboard → Pages → Create project"
echo "2. Connect GitHub repo (a8den/clutch)"
echo "3. Set build output directory to: site"
echo "4. Add custom domain: clutch.mancinimerchandising.com"
echo ""
echo "Worker URL: https://clutch-pricer.<your-subdomain>.workers.dev"
echo "Test it:    curl https://clutch-pricer.<your-subdomain>.workers.dev/status"
