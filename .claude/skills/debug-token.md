---
name: debug-token
description: Generate Akamai EdgeWorker debug token (10min expiry)
---

# Generate Debug Token

Generates a debug token for viewing EdgeWorker logs via `x-akamai-edgeworker-*` headers.

## Steps

1. **Generate token**:
   ```bash
   cd hints-reader
   npm run generate-token
   ```

2. **Display usage example**:
   ```bash
   TOKEN="<generated-token>"
   
   # Standard debug with Early Hints test
   curl https://<your-hostname>/early_hints -i \
     -H "Pragma: akamai-x-ew-debug" \
     -H "Akamai-EW-Trace: $TOKEN" \
     -H 'sec-fetch-mode: navigate' \
     -H 'user-agent: Chrome/111.0'
   
   # Include EdgeKV sub-requests
   curl https://<your-hostname>/early_hints -i \
     -H "Pragma: akamai-x-ew-debug, akamai-x-ew-debug-subs" \
     -H "Akamai-EW-Trace: $TOKEN" \
     -H 'sec-fetch-mode: navigate' \
     -H 'user-agent: Chrome/111.0'
   ```

3. **What to look for**:
   - `x-akamai-edgeworker-onclientrequest-log`: hints-reader logs
   - `x-akamai-edgeworker-onoriginresponse-log`: hints-updater logs
   - Expected messages:
     - "Loaded X static hint(s) from static_hints_config.ts"
     - "Found X hint(s) in collection"
     - "Set PMUSER_103_HINTS with X total hints"

## Token Details

- Valid for 10 minutes
- Hostname-specific (configured in package.json)
- Requires `--jsonout` flag for clean token output
