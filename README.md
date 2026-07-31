# Dynamic HTTP Early Hints on Akamai

Production-ready HTTP 103 Early Hints implementation using Akamai EdgeWorkers and EdgeKV. Combines static hints with dynamically discovered resources for optimal page load performance.

## Features

- ✅ **Single EdgeKV lookup** - Efficient single-item storage design
- ✅ **Intelligent version tracking** - Last-Modified headers with serial number fallback
- ✅ **Query string support** - Handles `?v=` and filename-based versioning
- ✅ **Stale-write protection** - Prevents old cache misses from overwriting newer entries
- ✅ **Customer-configurable** - Property Manager controls all triggers
- ✅ **Zero-downtime updates** - EdgeKV changes propagate without service interruption

## Architecture

**Single-item EdgeKV storage** for maximum efficiency:

- hints-reader: 1 EdgeKV read per HTML page
- hints-updater: 1 read + 1 write per cache miss (only for newer versions)

**Version tracking** prevents stale writes:

- Primary: Last-Modified header comparison
- Fallback: Serial number extraction from query strings or filenames

**⚠️ CRITICAL: Customer controls everything via Akamai Delivery (Property Manager):**

Both EdgeWorkers **ONLY fire when explicitly matched** in your delivery configuration:

- **hints-reader**: Configure to match HTML pages only
  - Examples: `/home`, `/index.html`, `*.html`
  - Fires on: `onClientRequest` (before cache)
- **hints-updater**: Configure to match specific critical resources only
  - Examples: `example.css`, `ruxitagentjs_*`, `*.js`, `*.woff2`
  - Fires on: `onOriginResponse` (cache miss only, after origin response)
  - **Be selective**: Only hint resources that benefit from early loading

Without Property Manager matches, **neither EdgeWorker will execute**. This is intentional—you control which paths/patterns trigger each EdgeWorker.

## Getting Started

### Prerequisites - Before You Begin

**Akamai Account Requirements:**

- Active Akamai contract with EdgeWorkers capability (Tier 200+)
- Property Manager access (to configure EdgeWorker triggers)
- EdgeKV enabled on your account (requires separate enablement)
- API credentials with EdgeWorkers, EdgeKV and purge permissions

_The Evaluation tier with EdgeWorkers and EdgeKV can be requested via https://control.akamai.com/apps/marketplace-ui/#/home_

**Local Tools:**

- Node.js 14+ and npm
- Akamai CLI with EdgeWorkers, EdgeKV, and Purge packages
- Command-line access (bash/zsh)

**Access Verification:**
If you're unsure whether your Akamai account has these capabilities, contact your Akamai account team or check the Akamai Control Center under:

- Administration → Contracts → EdgeWorkers
- Serverless

### 1. Install Akamai CLI and Packages

```bash
# Install Akamai CLI
brew install akamai  # macOS
# or download from: https://github.com/akamai/cli

# Install EdgeWorkers and EdgeKV CLI and purge packages
akamai install edgeworkers
akamai install edgekv
akamai install purge

# Verify installation
akamai edgeworkers --version
akamai edgekv --version

# Install Node.js (14+) if not already installed
node --version
npm --version
```

### 2. Set Up API Credentials

**Create API credentials in Akamai Control Center:**

1. Log in to https://control.akamai.com
2. Navigate to: **Identity & Access Management** → **API User** → **Create API Client**
3. Select these APIs with **READ-WRITE** access:
   - EdgeWorkers
   - EdgeKV
   - Property Manager (CPCode and Property)
   - Purge
4. Create credential and note the:
   - `client_secret`
   - `host`
   - `access_token`
   - `client_token`

**Create ~/.edgerc file:**

```bash
# Create credentials file
cat > ~/.edgerc <<EOF
[default]
client_secret = xxx_replace_with_your_secret_xxx
host = xxx_replace_with_your_host_xxx
access_token = xxx_replace_with_your_token_xxx
client_token = xxx_replace_with_your_token_xxx
EOF

# Secure the file
chmod 600 ~/.edgerc
```

**Verify credentials work:**

```bash
akamai edgeworkers list-ids --section default
# Should return a list (may be empty) without authentication errors
```

Full credential setup guide: https://techdocs.akamai.com/developer/docs/set-up-authentication-credentials

### 3. Clone and Configure

```bash
# Clone this repository
git clone <repository-url>
cd ew-dynamic-early-hints
```

### 4. Discover Your Akamai Group ID

You'll need this next step (EdgeKV namespace) and the one after (EdgeWorker IDs), so find it once now.

Your "group" in Akamai is an organizational container (often maps to a product line or environment).

```bash
# List available groups (use your .edgerc section name)
akamai edgeworkers list-groups --section default

# Example output:
# Group ID | Group Name
# 12345    | Production Group
# 67890    | Staging Group

# Note the Group ID you want to use (e.g., 12345)
```

**If you don't see any groups:**
Your API credentials may not have access. Contact your Akamai administrator or check your API client permissions in Control Center.

### 5. Initialize EdgeKV

The EdgeKV is initialized in an _account_. Each account can have different _namespaces_ and when you write a key-value _item_, it can be grouped using a _group_ name. You first need to initialize EdgeKV before you can create your own dedicated namespace.

More info regarding this data model can be found here: https://techdocs.akamai.com/edgekv/docs/edgekv-data-model

**IMPORTANT**: Create namespace in desired geographic location.

```bash
# Initialize EdgeKV (first time only - creates the EdgeKV database)
akamai edgekv initialize

# Create namespace in your preferred region or globally
# Available regions:
# - Staging: US
# - Production: US, EU, JP and GLOBAL. The GLOBAL location automatically replicates data to US, EU, and JP storage locations.
# If you use the GLOBAL location, reads are faster but write operations are slightly slower.
#
# Use the Group ID from step 4 above (--groupId, camelCase - the flag name is case-sensitive)
akamai edgekv create ns <production|staging> <your-namespace-name> --retention 0 --groupId <group-id> --geoLocation GLOBAL

# Example:
# akamai edgekv create ns production customer-global --retention 0 --groupId 12345 --geoLocation GLOBAL

# Verify namespace was created
akamai edgekv list ns <production|staging>

# Note: You'll create the access token later (step 7) after EdgeWorker IDs exist
```

**What just happened?**

- **Namespace**: Top-level container (like a database)
- **Group**: Collection of items within a namespace (like a table)
- **GeoLocation**: Primary storage region (data replicates globally but starts here)

### 6. Create EdgeWorker IDs

**What is an EdgeWorker ID?**
An EdgeWorker ID is a unique identifier that Akamai uses to track your deployed code. You need one ID per EdgeWorker (so two IDs total: one for hints-reader, one for hints-updater).

**Create EdgeWorker IDs using npm scripts.** Every script that touches an account-specific value (`edgerc_section`, `accountswitchkey`, `ewid`, `ew_group_id`, `hostname`) checks an environment variable first and only falls back to the `package.json` placeholder if that variable is unset — so you have two ways to supply real values:

**Option 1: `local-config.sh` (Recommended)** — keeps `package.json` free of real IDs, so the repo stays safe to commit/push at any time (this is how this project's own values are kept out of git):

```bash
# Copy the template once and fill in your real values
cp local-config.sh.example local-config.sh   # gitignored, never committed

# Edit local-config.sh:
export AKAMAI_EDGEGRID_SECTION="default"      # Your .edgerc section name
export AKAMAI_ACCOUNT_SWITCH_KEY=""           # Only if needed (ask your Akamai admin)
export EW_GROUP_ID="12345"                    # Your group ID from step 4
export HINTS_READER_EWID=""                   # Filled in after create-id below
export HINTS_UPDATER_EWID=""                  # Filled in after create-id below
export EW_HOSTNAME="your-hostname.example.com"

# Source it, then create each EdgeWorker ID
source ./local-config.sh
cd hints-reader && npm run create-id
# Note the EdgeWorker ID returned (e.g., 109849) — set it as HINTS_READER_EWID in local-config.sh

cd ../hints-updater && npm run create-id
# Note the EdgeWorker ID returned (e.g., 109850) — set it as HINTS_UPDATER_EWID in local-config.sh
```

After updating `local-config.sh`, re-run `source ./local-config.sh` before any further `npm run` command (deploy, generate-token, etc.) in that shell session.

**Option 2: Hardcode directly in `package.json`** — simpler for a one-off setup where you don't need the repo to stay push-safe (e.g. a private, single-purpose deployment):

```bash
# Configure hints-reader
cd hints-reader

# Edit package.json - update these values:
# - config.ew_group_id: Your group ID from step 4
# - config.edgerc_section: Your .edgerc section name (usually "default")
# - config.accountswitchkey: Only if needed (ask your Akamai admin)

# Create EdgeWorker ID
npm run create-id

# Note the EdgeWorker ID returned (e.g., 109849)
# Update package.json config.ewid with this ID

# Repeat for hints-updater
cd ../hints-updater

# Edit package.json with same group_id and edgerc_section
# Create EdgeWorker ID
npm run create-id

# Note the EdgeWorker ID returned (e.g., 109850)
# Update package.json config.ewid with this ID
```

**Multiple resource tiers on your contract?** `create-id` assigns a default resource tier automatically. If your contract has more than one (uncommon), list them with `akamai edgeworkers list-restiers --section default` and pass the correct one explicitly: `akamai edgeworkers --section default create-id <group-id> <name> --resourceTierId <id>`.

### 7. Create EdgeKV Access Token

Now that you have EdgeWorker IDs, create the access token:

```bash
# Create token and save directly to hints-reader
cd hints-reader/vendor
akamai edgekv create token earlyhints \
  --staging=allow \
  --production=allow \
  --ewids=<hints-reader-id>,<hints-updater-id> \
  --namespace=namespace-<your-namespace-name>+rwd \
  --save_path=./

# This creates edgekv_tokens.js automatically!

# Copy to hints-updater as well
cp edgekv_tokens.js ../../hints-updater/vendor/

# Example with actual values:
# cd hints-reader/vendor
# akamai edgekv create token earlyhints \
#   --staging=allow \
#   --production=allow \
#   --ewids=109849,109850 \
#   --namespace=namespace-mycompany-earlyhints+rwd \
#   --save_path=./
# cp edgekv_tokens.js ../../hints-updater/vendor/
```

**Token Parameters Explained:**

- `earlyhints` - Token name (choose your own)
- `--staging=allow` - Allow on staging network
- `--production=allow` - Allow on production network
- `--ewids=` - Comma-separated EdgeWorker IDs (no spaces!)
- `--namespace=namespace-<name>+rwd` - Namespace with permissions:
  - `+r` - Read only
  - `+rw` - Read/Write
  - `+rwd` - Read/Write/Delete (recommended)
- `--save_path=./` - Save to current directory (creates `edgekv_tokens.js`)

**CRITICAL**:

- The namespace format MUST be `namespace-<your-namespace-name>+<permissions>`
- The command automatically creates the correctly formatted `edgekv_tokens.js` file
- Copy the file to BOTH hints-reader and hints-updater vendor directories
- NEVER commit `edgekv_tokens.js` files - they're already in .gitignore
- Template files (`edgekv_tokens.js.template`) are for reference only

**Security Best Practice - Separate Tokens (Optional):**

For enhanced security, you can create separate tokens with different permissions:

```bash
# Token 1: Read-only for hints-reader
cd hints-reader/vendor
akamai edgekv create token earlyhints-reader \
  --staging=allow \
  --production=allow \
  --ewids=<hints-reader-id> \
  --namespace=namespace-<your-namespace-name>+r \
  --save_path=./

# Token 2: Read/Write/Delete for hints-updater
cd ../../hints-updater/vendor
akamai edgekv create token earlyhints-updater \
  --staging=allow \
  --production=allow \
  --ewids=<hints-updater-id> \
  --namespace=namespace-<your-namespace-name>+rwd \
  --save_path=./
```

This approach provides:

- **Principle of least privilege** - hints-reader only gets read access
- **Better security** - If hints-reader is compromised, EdgeKV can't be modified
- **Separate token rotation** - Revoke/renew independently

### 8. Configure Static Hints

Edit `hints-reader/src/static_hints_config.ts`:

```typescript
export const staticHints = [
  "<https://fonts.google.com>; rel=preconnect",
  "</main.css>; rel=preload; as=style",
  "</app.js>; rel=preload; as=script",
];
```

**Valid RFC 8297 formats:**

- Preconnect: `<url>; rel=preconnect`
- Preload: `<url>; rel=preload; as=type`
- Valid `as` types: `script`, `style`, `font`, `image`, `fetch`, `document`

### 9. Update EdgeKV Configuration

**REQUIRED**: Both EdgeWorkers ship with `EDGEKV_NAMESPACE = "CHANGE_ME"` — a placeholder that will fail at runtime. You must replace it in **both** files with the namespace you created in step 4, and it must be identical in both:

```typescript
// hints-reader/src/main.ts and hints-updater/src/main.ts
const EDGEKV_NAMESPACE = "your-namespace-name"; // Change this in BOTH files!
const EDGEKV_GROUP = "earlyHints";
```

### 10. Deploy to Staging

If you used `local-config.sh` (step 6, Option 1), source it first in each shell session — otherwise the deploy scripts fall back to whatever placeholders are in `package.json`:

```bash
# Deploy hints-reader
cd hints-reader
npm install
source ../local-config.sh   # skip if you hardcoded values in package.json (step 6, Option 2)
npm run deploy:staging

# Deploy hints-updater
cd ../hints-updater
npm install
source ../local-config.sh   # skip if you hardcoded values in package.json (step 6, Option 2)
npm run deploy:staging
```

### 11. Configure Reset Management Script

The management script supports both direct configuration and environment variables:

**Option 1: Configure via Environment Variables (Recommended)**

```bash
# Set environment variables for this session
export AKAMAI_EDGEGRID_SECTION="default"
export AKAMAI_ACCOUNT_SWITCH_KEY="B-M-XXX:1-XXX"  # Optional - see note below

# Make script executable
chmod +x manage-hints.sh

# Run commands (uses env vars)
./manage-hints.sh --show-content

# Or set for a single command
AKAMAI_EDGEGRID_SECTION=production ./manage-hints.sh --show-content
```

**Option 2: Edit Script Defaults**

```bash
# Edit manage-hints.sh
nano manage-hints.sh  # or use your preferred editor

# Update these variables (lines 24-28):
EDGERC_SECTION="${AKAMAI_EDGEGRID_SECTION:-default}"
ACCOUNT_SWITCH_KEY="${AKAMAI_ACCOUNT_SWITCH_KEY:-}"
EDGEKV_NAMESPACE="your-namespace-name"      # Your EdgeKV namespace (from step 5)
EDGEKV_GROUP="earlyHints"                   # Group name (from step 5)
NETWORK="staging"                           # Start with staging
```

**About ACCOUNT_SWITCH_KEY:**

- Only needed if you manage multiple Akamai accounts
- Format: `B-M-XXXXXX:1-XXXXXX`
- Find it in Control Center → Account Admin → Account Switching Key
- If you don't use account switching, omit the environment variable or leave script value empty
- The script automatically skips `--accountkey` when this is unset/empty

### 12. Configure Akamai Delivery (Property Manager)

**⚠️ THIS IS CRITICAL - EdgeWorkers ONLY fire when matched in Property Manager!**

Without these configurations, neither EdgeWorker will execute. You have complete control over which requests trigger each EdgeWorker.

**Where to configure:**

1. Log in to https://control.akamai.com
2. Navigate to: **CDN** → **Properties** → Select your property
3. Click **Edit New Version** (creates a draft you can activate later)
4. Find or create a rule in your property configuration

**How to configure:**
You'll add two separate EdgeWorker behaviors - one for hints-reader (HTML pages), one for hints-updater (critical resources).

#### hints-reader Configuration (HTML Pages)

**Add a new rule in Property Manager:**

1. Click **Add Rule** → Name it: "Early Hints - Reader"

2. **Add Match Criteria - BE SELECTIVE:**

   Choose which HTML pages should receive early hints. Don't match every page—focus on high-value pages.
   - Click **Add Match**
   - **Option A - Specific paths (recommended):**
     - **Path is one of**: `/`, `/home`, `/index.html`, `/products/`, `/shop/`
     - **Path matches**: `/blog/*`, `/articles/*`
   - **Option B - All HTML files (broader):**
     - **File Extension**: `html`
     - **Content Type**: `text/html`

   **Why be selective?**
   - EdgeKV lookups have cost—only use where performance matters
   - Focus on landing pages, product pages, and conversion paths
   - Skip admin pages, error pages, or low-traffic pages

3. **Add EdgeWorker Behavior:**
   - Click **Add Behavior** → Search for "EdgeWorkers"
   - **EdgeWorker ID**: `<your-hints-reader-id>` (from step 6)
   - **Enabled**: ON

4. **Add Early Hints Behavior:**
   - **Create** PMUSER_103_HINTS variable
   - Click **Add Behavior** → Search for "Early Hints"
   - **Enabled**: ON
   - **Resource URL**: `{{user.PMUSER_103_HINTS}}`

   This behavior sends the HTTP 103 Early Hints response using the variable set by the EdgeWorker.

   Documentation: https://techdocs.akamai.com/property-mgr/docs/early-hints

**How it works:**

- When a request matches (e.g., `/home` or `*.html`), both behaviors fire
- EdgeWorker runs first, reads EdgeKV, sets `PMUSER_103_HINTS` variable
- Early Hints behavior reads that variable and sends HTTP 103 response to browser
- All within the same request flow - no separate configuration needed

**Visual example of rule structure:**

```
Rule: Early Hints - Reader
├─ Match: Path is one of: /, /home, /products/
├─ Match: Path matches: /blog/*, /articles/*
├─ Behavior: EdgeWorkers
│  └─ EdgeWorker ID: <hints-reader-id>
└─ Behavior: Early Hints
   └─ Resource URL: {{user.PMUSER_103_HINTS}}
```

**Example selective configurations:**

Minimal (landing page only):

```
IF: Path is one of: /, /home
THEN: Enable hints-reader
```

E-commerce site (landing + product pages):

```
IF:
  Path is one of: /, /home
  OR Path matches: /products/*, /shop/*
THEN: Enable hints-reader
```

Content site (landing + articles):

```
IF:
  Path is one of: /
  OR Path matches: /blog/*, /articles/*
THEN: Enable hints-reader
```

**JSON structure (for advanced users):**

```json
{
  "name": "earlyHints",
  "options": {
    "enabled": true,
    "resourceUrl": "{{user.PMUSER_103_HINTS}}"
  }
}
```

#### hints-updater Configuration (Critical Resources)

Add EdgeWorker behavior in Property Manager:

**Add another new rule in Property Manager:**

1. Click **Add Rule** → Name it: "Early Hints - Updater"
2. **Add Match Criteria - BE SELECTIVE:**
   - Click **Add Match**
   - **Option A - Specific files (recommended):**
     - **Path is one of**: `example.css`, `main.css`, `app.js`
     - **Path matches**: `ruxitagentjs_*`
   - **Option B - File types (broader):**
     - **File Extension is one of**: `css`, `js`, `woff2`

3. **Add EdgeWorker Behavior:**
   - Click **Add Behavior** → Search for "EdgeWorkers"
   - **EdgeWorker ID**: `<your-hints-updater-id>` (from step 6)
   - **Enabled**: ON

**Visual example of rule structure:**

```
Rule: Early Hints - Updater
├─ Match: Path is one of: example.css, main.css, app.js
├─ Match: Path matches: ruxitagentjs_*
└─ Behavior: EdgeWorkers
   └─ EdgeWorker ID: <hints-updater-id>
```

**Key Points:**

- This EdgeWorker automatically fires on origin responses (cache misses only)
- No additional behaviors needed - EdgeWorker handles everything
- Be selective with matches - only critical resources that benefit from early hints
- Non-cacheable resources (`cache-control: no-store`) are harmless but won't benefit from hints

**Activate the property** in Akamai Control Center after configuration.

### 13. Verify Deployment

**Test HTTP 103 Early Hints Response:**

The correct way to verify early hints are working is to check for the actual HTTP 103 interim response:

```bash
# Test with browser-like headers
curl https://your-domain.com/index.html -i \
  -H 'sec-fetch-mode: navigate' \
  -H 'user-agent: Chrome/111.0'
```

Expected output:

```
HTTP/2 103
link: <https://fonts.google.com>; rel=preconnect, </main.css>; rel=preload; as=style, </app.js>; rel=preload; as=script

HTTP/2 200
...
```

**Key points:**

- Must use `-i` to see interim responses
- `sec-fetch-mode: navigate` signals browser navigation (required for Early Hints)
- `user-agent: Chrome/111.0` identifies as a browser that supports Early Hints
- You should see **HTTP/2 103** first with `link:` header, then **HTTP/2 200**

**Debug with Enhanced Headers:**

For detailed EdgeWorker logs, add debug headers:

```bash
# Generate debug token
cd hints-reader
npm run generate-token

# Test with debug + Early Hints verification
TOKEN="<generated-token>"
curl https://your-domain.com/index.html -i \
  -H "Pragma: akamai-x-ew-debug" \
  -H "Akamai-EW-Trace: $TOKEN" \
  -H 'sec-fetch-mode: navigate' \
  -H 'user-agent: Chrome/111.0'
```

Look for these in the response headers:

- `HTTP/2 103` response before `HTTP/2 200`
- `x-akamai-edgeworker-onclientrequest-log:` with messages like:
  - `Loaded X static hint(s) from static_hints_config.ts`
  - `Found X hint(s) in collection`
  - `Set PMUSER_103_HINTS with X total hints`

**Check EdgeKV contents:**

```bash
./manage-hints.sh --show-content
```

### Production Logging with DataStream 2

For production monitoring and debugging without debug headers, use **DataStream 2** to stream EdgeWorker logs to external storage.

**Why DataStream 2?**

Debug headers (`Pragma: akamai-x-ew-debug`) are designed for development and require per-request tokens. For production:

- **Persistent logging** - Capture all EdgeWorker logs continuously
- **No per-request setup** - No debug tokens needed
- **External storage** - Send logs to S3, Splunk, or other destinations
- **Production-safe** - No impact on cache behavior or response headers
- **Monitoring ready** - Feed logs into your observability platform

**Setup Steps:**

1. **Prerequisites:**
   - EdgeWorkers and DataStream 2 enabled on your Akamai contract
   - "Data Stream 2 EdgeWorker Write Access Only" permission
   - Configure log destination (S3-compatible storage, etc.)

2. **Create DataStream 2 stream:**

   ```bash
   # Via Akamai Control Center:
   # 1. Navigate to: Analytics & monitor → DataStream
   # 2. Click "Create stream"
   # 3. Select "EdgeWorkers" as the product
   # 4. Choose log format (JSON recommended)
   # 5. Configure destination (S3, Splunk, etc.)
   # 6. Note the Stream ID (e.g., 12345)
   ```

3. **Add logging configuration to bundle.json:**

   Edit both `hints-reader/built/bundle.json` and `hints-updater/built/bundle.json` after running `npm run build`:

   ```json
   {
     "edgeworker-version": "1.0.0",
     "description": "...",
     "logging": {
       "level": "info",
       "schema": "v1",
       "ds2id": 12345
     }
   }
   ```

   **Log levels:** `trace`, `debug`, `info`, `warn`, `error` (default: `error`)

4. **Update package.json build script** to include logging config:

   Add to `package:bundle` script in both EdgeWorkers' `package.json`:

   ```json
   "package:bundle": "mkdir -p built && jq -n --arg version \"$npm_package_version\" --arg desc \"$npm_package_description\" --argjson logging '{\"level\":\"info\",\"schema\":\"v1\",\"ds2id\":12345}' '{\"edgeworker-version\": $version, \"description\": $desc, \"logging\": $logging}' > built/bundle.json"
   ```

5. **Deploy:**

   ```bash
   npm run deploy:staging  # or deploy:production
   ```

6. **Verify logs:**
   - Logs appear in your configured destination after ~2 minutes
   - Check for `logger.info()`, `logger.warn()`, `logger.error()` messages

**Important Notes:**

- The EdgeWorker must be in the same group (or sub-group) as the DataStream 2 stream
- Invalid or inactive `ds2id` will prevent EdgeWorker activation
- Set log level to `info` or `warn` for production (avoid `debug` or `trace` - high volume)
- This project already uses `logger` from `log` module - no code changes needed

**Documentation:** https://techdocs.akamai.com/edgeworkers/docs/ds2-javascript-logging

## How It Works

### Storage Format

Single EdgeKV item (`all_hints`) stores all hints:

```json
{
  "/static/example.css": {
    "path": "/static/example.css?v=10",
    "lastModified": "Wed, 21 Jul 2026 15:30:00 GMT"
  },
  "/js/ruxitagentjs": {
    "path": "/js/ruxitagentjs_ABC_10329260115094563.js",
    "lastModified": null
  }
}
```

### Version Tracking

**Primary: Last-Modified Header**

```
Incoming:  Last-Modified: Wed, 21 Jul 2026 16:00:00 GMT
Existing:  Last-Modified: Wed, 21 Jul 2026 15:00:00 GMT
Decision:  UPDATE (incoming is newer)
```

**Fallback: Serial Number Extraction**

Query string versions:

```
example.css?v=202607214303 → serial: 202607214303
example.css?v=202607214302 → serial: 202607214302
Comparison: BigInt(202607214303) > BigInt(202607214302) = true → UPDATE
```

Filename versions:

```
ruxitagentjs_ABC_10329260115094563.js → serial: 10329260115094563
ruxitagentjs_ABC_10329260115094560.js → serial: 10329260115094560
Comparison: BigInt(10329260115094563) > BigInt(10329260115094560) = true → UPDATE
```

### Stale-Write Protection

```
Stored:   example.css?v=10
Incoming: example.css?v=08 (cache miss on old reference)
Decision: SKIP (08 < 10, keep existing)
```

This prevents cold edge POPs serving old pages from overwriting newer entries.

## Management Operations

### Show Current Hints

```bash
./manage-hints.sh --show-content
```

### Full Reset

```bash
./manage-hints.sh --full-reset
```

Run after:

- Static hints configuration changes
- Property Manager pattern updates
- Major system changes

### Delete Specific Hint

```bash
./manage-hints.sh --delete-key /static/example.css
```

### Purge Specific Object by URL (First-Time Use)

Use this when cache tags do not exist yet for an object and you need to force a cache miss so the updater EdgeWorker runs.

No manual invalidation in Akamai Control Center is required for this step. You can invalidate a single object directly from the command line using this script.

```bash
# Provide full URL directly
./manage-hints.sh --purge-path https://www.example.com/static/example.css?v=10
```

### Property Manager configuration unclear

**Where is Property Manager?**

- Akamai Control Center: https://control.akamai.com
- Navigate to: **CDN** → **Properties**
- If you don't see Properties, you may not have permission - contact your Akamai admin

**Can't find EdgeWorker behavior?**

- Search for "EdgeWorkers" in the behavior search box
- If not available, your property may not support EdgeWorkers
- Check property product: Must be Ion, Dynamic Site Accelerator, or similar

**Need help with Property Manager?**

- Official docs: https://techdocs.akamai.com/property-mgr/docs
- Video tutorials: https://learn.akamai.com (search "Property Manager")
- Contact Akamai support or your account team

## Logical Key Extraction

Resources are deduplicated by logical key:

| Request Path                  | Logical Key           | Stored Path                                  |
| ----------------------------- | --------------------- | -------------------------------------------- |
| `/static/example.css`         | `/static/example.css` | `/static/example.css`                        |
| `/static/example.css?v=10`    | `/static/example.css` | `/static/example.css?v=10`                   |
| `/static/example.css?v=09`    | `/static/example.css` | (skipped, older)                             |
| `/js/ruxitagentjs_ABC_123.js` | `/js/ruxitagentjs`    | `/js/ruxitagentjs_ABC_123.js`                |
| `/js/ruxitagentjs_ABC_456.js` | `/js/ruxitagentjs`    | `/js/ruxitagentjs_ABC_456.js` (if 456 > 123) |

## Making a Small Change (e.g. Updating Static Hints)

Most day-to-day changes are just editing `hints-reader/src/static_hints_config.ts` and redeploying. Steps:

1. **Edit the file:**

   ```bash
   nano hints-reader/src/static_hints_config.ts
   ```

   ```typescript
   export const staticHints = [
     "<https://fonts.google.com>; rel=preconnect",
     "</main.css>; rel=preload; as=style",
     "</app.js>; rel=preload; as=script",
     "</new-file.css>; rel=preload; as=style", // added
   ];
   ```

2. **Bump the version** (Akamai won't let you re-activate an already-active version):

   ```bash
   cd hints-reader
   npm version patch   # or minor/major - see Version Management below
   ```

3. **Build, package, upload, and activate in one command:**

   ```bash
   npm run deploy:staging      # test first
   # once verified:
   npm run deploy:production
   ```

   Static hints are compiled into the EdgeWorker bundle and read fresh on every request — no EdgeKV reset or cache purge needed. As soon as the new version is active, the next request picks up the change.

4. **Verify** the new hint appears in the HTTP 103 response (see [Verify Deployment](#13-verify-deployment)):

   ```bash
   curl https://your-domain.com/index.html -i \
     -H 'sec-fetch-mode: navigate' \
     -H 'user-agent: Chrome/111.0'
   ```

Changing `hints-updater`'s logic (e.g. version-comparison rules) follows the same pattern — edit `hints-updater/src/main.ts`, bump its version, then `npm run deploy:staging`/`deploy:production` from the `hints-updater` directory.

`./manage-hints.sh --full-reset` is only needed when the EdgeKV storage schema or logical-key extraction logic changes, or when Property Manager match criteria change — not for routine static-hints or logic edits (it only clears *dynamic* hints written by `hints-updater`, which are unrelated to static hints).

## Project Structure

```
.
├── hints-reader/               # EdgeWorker for reading hints
│   ├── src/
│   │   ├── main.ts            # Main logic
│   │   ├── static_hints_config.ts  # Customer-editable static hints
│   │   └── edgekv.d.ts        # Type definitions
│   ├── vendor/
│   │   ├── edgekv.js          # EdgeKV helper library
│   │   └── edgekv_tokens.js   # Access token (CREATE THIS - DO NOT COMMIT)
│   ├── package.json
│   └── tsconfig.json
├── hints-updater/              # EdgeWorker for updating hints
│   ├── src/
│   │   ├── main.ts            # Main logic
│   │   └── edgekv.d.ts        # Type definitions
│   ├── vendor/
│   │   ├── edgekv.js          # EdgeKV helper library
│   │   └── edgekv_tokens.js   # Access token (CREATE THIS - DO NOT COMMIT)
│   ├── package.json
│   └── tsconfig.json
├── manage-hints.sh              # Management script
├── .gitignore                  # Excludes vendor/edgekv_tokens.js
├── README.md                   # This file
└── CLAUDE.md                   # Development guide
```

## Version Management

```bash
# Bump version before each deploy
npm version patch   # Bug fixes (1.0.x)
npm version minor   # New features (1.x.0)
npm version major   # Breaking changes (x.0.0)

# Deploy
npm run deploy:staging
npm run deploy:production
```

You cannot re-activate an already-active version. Always bump first.

## Troubleshooting

### Hints not showing up

1. **Check Property Manager activation**:
   - Did you activate the property to staging/production?
   - Check activation status in Control Center → Properties → Activations
   - Allow 5-10 minutes for activation to complete

2. **Check Property Manager triggers**:
   - Is hints-reader enabled on HTML pages?
   - Is the path actually matching your criteria?
   - Test a known path like `/index.html`

3. **Check EdgeKV content**:

   ```bash
   ./manage-hints.sh --show-content
   ```

   If empty, hints-updater hasn't run yet or isn't matching resources.

4. **Verify origin provides Last-Modified headers** (helps with versioning):

   ```bash
   curl -I "https://your-origin.com/resource.css" | grep -i last-modified
   ```

5. **Enable debug headers**:
   ```bash
   cd hints-reader
   npm run generate-token
   curl -I "https://your-domain.com/page.html" \
     -H "Pragma: akamai-x-ew-debug" \
     -H "Akamai-EW-Trace: <TOKEN>"
   ```

### EdgeKV "MISSING ACCESS TOKEN" error

The token file needs `namespace-` prefix:

```javascript
"namespace-mycompany": { ... }  // Correct
"mycompany": { ... }            // Wrong
```

### Old versions not being replaced

1. **Check Last-Modified headers** from origin:

   ```bash
   curl -I "https://origin.com/resource.css" | grep -i last-modified
   ```

2. **Verify serial extraction** - ensure version numbers are digits only:
   - Query: `?v=123456` (digits only)
   - Filename: `_123456.ext` (digits before extension)

### EdgeWorker not firing

1. **Check EdgeWorker tier requirement**:
   - EdgeKV requires EdgeWorkers Tier 200 or higher
   - Verify in Control Center → Account Admin → Contracts
   - Contact Akamai account team if you need to upgrade

2. **Verify Property Manager activation**:
   - Changes only take effect after activation
   - Check activation status and network (staging vs production)

3. **Check Property Manager match criteria**:
   - EdgeWorkers ONLY fire when matched
   - Test with a path you know matches (e.g., `/index.html` for hints-reader)
   - Use debug headers to see which rules are firing

4. **Check EdgeWorker deployment status**:

   ```bash
   cd hints-reader
   akamai edgeworkers list-ids
   # Look for your EdgeWorker ID and verify it shows "active"
   ```

5. **Verify hints-updater only fires on cache misses**:
   - First request to a resource = cache miss = EdgeWorker fires
   - Subsequent requests = cache hit = EdgeWorker does NOT fire
   - Use `curl -I` and check for `x-cache: TCP_HIT` vs `TCP_MISS`

## Performance Notes

- **hints-reader**: 1 EdgeKV read per HTML page request (~10ms)
- **hints-updater**: 1 EdgeKV read + 1 write per cache miss (~10ms)
- **EdgeKV propagation**: ~10 seconds globally
- **No blocking**: hints-reader falls back to static hints on EdgeKV failure

## Limitations

- **PMUSER variable size**: 8KB total for all hints combined
- **EdgeKV item size**: 1MB maximum (stores thousands of hints)
- **Cache tags**: Maximum 50 tags per response
- **EdgeWorker tier**: Tier 200+ required for EdgeKV access
- **Non-cacheable resources**: Automatically ignored (by design)

## Security Notes

- **Never commit** `vendor/edgekv_tokens.js` - contains access credentials
- **Verify .gitignore** includes `vendor/edgekv_tokens.js`
- **Rotate tokens** annually or when team members change
- **Limit token scope** to only required EdgeWorker IDs
- **Use separate tokens** for staging and production if possible

## Support

For issues or questions:

1. Check the troubleshooting section above
2. Review Property Manager configuration
3. Check EdgeKV content with `./manage-hints.sh --show-content`
4. Enable debug headers for detailed logging

## License

Proprietary - Internal use only.
