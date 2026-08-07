#!/bin/sh
# Publishes the SDK twice from one source, so the test build can never drift
# from the real one:
#
#   /customercatalyst.js       → writes to the Live project (the file as committed)
#   /dev/customercatalyst.js   → same code, pointed at the Test project
#
# The Test project's URL and publishable key come from build variables set in
# Cloudflare, so they are not committed here.
set -e

mkdir -p dist
cp customercatalyst.js dist/

if [ -z "$DEV_PROJECT_REF" ] || [ -z "$DEV_PUBLISHABLE_KEY" ]; then
  # Deliberately not fatal: a missing test variable must never block shipping a
  # fix to production. The /dev/ path 404s, which is a visible signal.
  echo "WARNING: DEV_PROJECT_REF or DEV_PUBLISHABLE_KEY not set — skipping the test build."
  exit 0
fi

mkdir -p dist/dev
sed -E \
  -e "s#(const SUPABASE_URL = ')[^']*#\1https://${DEV_PROJECT_REF}.supabase.co#" \
  -e "s#(const SUPABASE_PUBLISHABLE_KEY = ')[^']*#\1${DEV_PUBLISHABLE_KEY}#" \
  customercatalyst.js > dist/dev/customercatalyst.js

# Fail loudly rather than publish a "test" build that still points at Live.
if grep -q "${DEV_PROJECT_REF}" dist/dev/customercatalyst.js; then
  echo "Test build points at ${DEV_PROJECT_REF}."
else
  echo "ERROR: the test build did not get the test project — refusing to publish it."
  exit 1
fi
