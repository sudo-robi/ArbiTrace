#!/bin/bash
# Regenerate all sample data for ArbiTrace
# Usage: bash regenerate_data.sh

set -e

echo "🔄 Regenerating ArbiTrace sample data..."
echo ""

# Stop any running server
echo "⏹️  Stopping any running servers..."
pkill -f "npm run dev" || true
sleep 1

# Delete existing databases
echo "🗑️  Clearing existing databases..."
rm -f data/patterns.db data/patterns.db-wal data/patterns.db-shm
rm -f data/sessions.db data/sessions.db-wal data/sessions.db-shm
echo "✅ Databases cleared"
echo ""

# Populate pattern archive data
echo "📊 Populating pattern archive (patterns.db)..."
node populate_sample_data.js
echo ""

# Populate leaderboard data
echo "📈 Populating leaderboard analytics (sessions.db)..."
node populate_leaderboard_data.js
echo ""

# Populate sample logs
echo "📝 Populating sample logs and trace data..."
node populate_sample_logs.js
echo ""

# Restart server
echo "🚀 Starting development server..."
npm run dev &
SERVER_PID=$!

sleep 3

# Test endpoints
echo ""
echo "✅ Testing endpoints..."
echo ""

echo "1️⃣  Testing /leaderboard/stats:"
curl -s http://localhost:3000/leaderboard/stats | python3 -m json.tool | head -15
echo ""

echo "2️⃣  Testing /leaderboard/risky:"
curl -s 'http://localhost:3000/leaderboard/risky?limit=3' | python3 -m json.tool | head -30
echo ""

echo "3️⃣  Testing /leaderboard/failure-types:"
curl -s http://localhost:3000/leaderboard/failure-types | python3 -m json.tool
echo ""

echo "4️⃣  Testing /validate/pre-submit:"
curl -s -X POST http://localhost:3000/validate/pre-submit \
  -H "Content-Type: application/json" \
  -d '{"gasLimit": 100000, "maxFeePerGas": 5000000000, "submissionCost": 50000}' | python3 -m json.tool | head -20
echo ""

echo "✅ All endpoints tested successfully!"
echo ""
echo "📍 Server is running at http://localhost:3000"
echo "🌐 Open the UI and click the 📊 button to see the leaderboard"
echo ""
echo "🛑 To stop the server, run: kill $SERVER_PID"
