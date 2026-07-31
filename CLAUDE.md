# Dynamic HTTP Early Hints on Akamai

HTTP 103 Early Hints service on Akamai, combining static hints with dynamically discovered resources stored in EdgeKV. Built for production use with efficient single-item storage and intelligent version tracking.

## Architecture Overview

The system uses two EdgeWorkers that communicate via a single EdgeKV item.

**⚠️ CRITICAL: Both EdgeWorkers ONLY fire when explicitly matched in Akamai Delivery (Property Manager) configuration.**

Without Property Manager match criteria:

- **hints-reader** will NOT fire (even on HTML requests)
- **hints-updater** will NOT fire (even on cache misses)

The customer has complete control over which paths/patterns trigger each EdgeWorker.

```
┌─────────┐
│  User   │ requests HTML page
└────┬────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│           Akamai Edge (hints-reader)        │
│  onClientRequest                            │
│  ┌─────────────────────────────────────┐   │
│  │ 1. Read all_hints (1 EdgeKV lookup) │   │
│  │ 2. Merge static + dynamic hints     │   │
│  │ 3. Set PMUSER_103_HINTS variable    │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Property Manager emits HTTP 103 Early     │
│  Hints response before final response      │
└─────────────────────────────────────────────┘
     │
     ▼
   HTTP 103 + hints sent to browser
   HTTP 200 + HTML follows


┌─────────┐
│  User   │ requests JS/CSS resource
└────┬────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│          Akamai Edge (Cache Miss)           │
└─────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│              Origin Server                  │
│  Returns 200 OK + Last-Modified             │
└─────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│        Akamai Edge (hints-updater)          │
│  onOriginResponse (cache miss only)         │
│  ┌─────────────────────────────────────┐   │
│  │ 1. Read all_hints (1 EdgeKV read)   │   │
│  │ 2. Extract logical key              │   │
│  │ 3. Compare versions (Last-Modified  │   │
│  │    or serial number)                │   │
│  │ 4. Update if newer (1 EdgeKV write) │   │
│  │ 5. Set Edge-Cache-Tag header        │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## EdgeKV Storage Design

**Single-item architecture** for maximum efficiency:

```json
// EdgeKV item: "all_hints"
{
  "/static/example.css": {
    "path": "/static/example.css?v=10",
    "lastModified": "Wed, 21 Jul 2026 15:30:00 GMT"
  },
  "/js/ruxitagentjs": {
    "path": "/js/ruxitagentjs_ICA7NVfghqrux_10329260115094563.js",
    "lastModified": null
  },
  "/main.css": {
    "path": "/main.css",
    "lastModified": "Tue, 20 Jul 2026 10:15:00 GMT"
  }
}
```

**Why single-item storage?**

- **Performance**: hints-reader does 1 EdgeKV read instead of N+1 (index + N items)
- **Simplicity**: No index maintenance, no iteration logic
- **Atomic updates**: hints-updater reads once, updates object, writes once
- **Cost efficiency**: Fewer EdgeKV operations = lower cost
- **Limited number of entries**: There is going to be a small number of early hints entries anyway

**Path-based keys** ensure correct resource URLs:

- Key includes full path: `/static/image.svg` (not just `image.svg`)
- Works correctly for subdirectories and nested paths
- No ambiguity between `/image.svg` and `/static/image.svg`

## Version Tracking

The system prevents stale cache misses from overwriting newer entries using a two-tier comparison:

### Primary: Last-Modified Header

When origin provides `Last-Modified` headers:

```
Incoming:  Last-Modified: Wed, 21 Jul 2026 16:00:00 GMT
Existing:  Last-Modified: Wed, 21 Jul 2026 15:00:00 GMT
Result:    UPDATE (incoming is newer)
```

### Fallback: Serial Number Extraction

When `Last-Modified` is absent, extract version from:

1. **Query string**: `example.css?v=202607214303` → serial `202607214303`
2. **Filename pattern**: `ruxitagentjs_ABC_10329260115094563.js` → serial `10329260115094563`

Serial comparison uses `BigInt` for accurate large number comparison:

```javascript
BigInt("10329260115094563") > BigInt("10329260115094560"); // true
```

**Example scenario:**

```
1. Cache miss: /static/example.css?v=10 → stores under key "/static/example.css"
2. Cache miss: /static/example.css?v=09 → compares: 09 < 10 → SKIP (keeps v=10)
3. Cache miss: /static/example.css?v=11 → compares: 11 > 10 → UPDATE (replaces with v=11)
```

This prevents cold edge POPs serving old page references from clobbering newer entries.

## EdgeWorker Components

### hints-reader (EW 1)

**Trigger**: `onClientRequest` - **ONLY fires when matched in Property Manager**

**⚠️ CRITICAL**: This EdgeWorker will NOT execute unless Property Manager match criteria are configured.

**Property Manager Configuration Required - BE SELECTIVE**:

Configure Property Manager to match ONLY specific HTML pages where early hints provide value:

**Best Practice - Match specific paths:**

- Landing pages: `/`, `/home`, `/index.html`
- Product pages: `/products/*`, `/shop/*`
- Article pages: `/blog/*`, `/articles/*`

**Alternative - Match HTML file types (broader):**

- File extension: `*.html`

**Why selective matching?**

- EdgeKV lookups have cost - only use where early hints improve performance
- Not every page benefits from early hints (e.g., admin pages, error pages)
- Focus on high-traffic landing pages and conversion paths
- **Do NOT match every request** - only HTML pages that need early hints

**Example selective configuration:**

```
IF:
  Path is one of:
    - /
    - /home
    - /products/
    - /shop/
  OR
  Path matches pattern:
    - /blog/*
    - /articles/*
THEN:
  Enable EdgeWorker (hints-reader)
```

**Flow**:

1. Load static hints from `static_hints_config.ts`
2. Read `all_hints` from EdgeKV (1 lookup)
3. Build hint strings from all entries
4. Merge static + dynamic hints
5. Set `PMUSER_103_HINTS` variable
6. Property Manager emits HTTP 103 response

**Performance**: Single EdgeKV read, never blocks on failure (falls back to static hints only)

### hints-updater (EW 2)

**Trigger**: `onOriginResponse` - **ONLY fires when matched in Property Manager**

**⚠️ CRITICAL**: This EdgeWorker will NOT execute unless Property Manager match criteria are configured.

**Property Manager Configuration Required**:
Customer must configure Property Manager to match ONLY specific critical resources:

**Be selective - match specific files that benefit from early hints:**

- Specific patterns: `example.css`, `main.css`, `ruxitagentjs_*`
- Critical file types: `*.js`, `*.css`, `*.woff2` (only if needed)
- Cache miss only: Akamai automatically scopes to cache misses
- **Do NOT match all resources** - only hint critical assets that need early loading

**Example selective configuration:**

```
IF:
  Path is one of:
    - example.css
    - main.css
    - app.js
  OR
  Path matches pattern: ruxitagentjs_*
THEN:
  Enable EdgeWorker (hints-updater)
```

**Flow**:

1. Verify response is 200 OK
2. Get full URL path from `request.url` (includes path + query string)
3. Derive logical key by stripping query string and serial patterns from URL
4. Read `all_hints` from EdgeKV
5. Compare versions (Last-Modified or serial number)
6. Update entry if incoming is newer
7. Write `all_hints` back to EdgeKV
8. Set `Edge-Cache-Tag: early-hints,hints-<key>`

**Performance**: 1 EdgeKV read + 1 write per cache miss (only for newer versions)

## Logical Key Extraction

Deduplication is based on logical keys derived from full paths:

| Path Pattern                  | Logical Key           | Purpose                |
| ----------------------------- | --------------------- | ---------------------- |
| `/static/example.css`         | `/static/example.css` | Static file            |
| `/static/example.css?v=10`    | `/static/example.css` | Query-string versioned |
| `/js/ruxitagentjs_ABC_123.js` | `/js/ruxitagentjs`    | Underscore pattern     |
| `/main.css`                   | `/main.css`           | Static file            |
| `/assets/image.svg?v=5`       | `/assets/image.svg`   | Query-string versioned |

This ensures only the latest version of each resource is stored, with correct full paths.

## Static Hints Configuration

Customer-editable file: `hints-reader/src/static_hints_config.ts`

```typescript
export const staticHints = [
  "<https://fonts.google.com>; rel=preconnect",
  "</main.css>; rel=preload; as=style",
  "</app.js>; rel=preload; as=script",
];
```

**RFC 8297 Format**:

- Preconnect: `<url>; rel=preconnect`
- Preload: `<url>; rel=preload; as=type`
- Valid `as` types: `script`, `style`, `font`, `image`, `fetch`, `document`

After editing static hints:

1. Deploy the updated hints-reader EdgeWorker

Static hints are compiled into the EdgeWorker bundle and loaded fresh on every request (independent of EdgeKV), so no EdgeKV reset or cache purge is needed — the next request after activation picks up the change. A reset is only required for EdgeKV storage-schema changes, logical-key extraction changes, or Property Manager match-criteria changes.

## Property Manager Configuration

**⚠️ CRITICAL: Without these configurations, EdgeWorkers will NOT execute.**

### hints-reader EdgeWorker

**Behavior**: EdgeWorker (ID: customer-specific)

**Match Criteria** (example - customer MUST configure):

```
IF:
  - filename matches: *.html
  OR
  - Path is one of: /, /home, /landing
THEN:
  - Enable EdgeWorker (hints-reader)
```

**Without this match, hints-reader will NOT fire on ANY request.**

**HTTP 103 Response** (after EdgeWorker sets variable):

```
Send 103 Early Hints response with:
  Link: {{user.PMUSER_103_HINTS}}
```

### hints-updater EdgeWorker

**Behavior**: EdgeWorker (ID: customer-specific)

**Match Criteria - BE SELECTIVE, we don't want to use too many files in early hints** (example - customer MUST configure):

```
IF:
  - filename is one of:
      - example.css
      - main.css
      - app.js
      - ruxitagentjs_*
THEN:
  - Enable EdgeWorker (hints-updater)
```

**Key Points**:

- **Without this match, hints-updater will NOT fire on ANY request**
- EdgeWorker automatically scopes to cache miss (onOriginResponse)
- EdgeWorker code checks `response.status === 200` before processing
- **Be selective**: Only match critical resources that benefit from early hints
- Do NOT match every resource - only hint files that need early loading as there is a limit defined

## Testing

### Test HTTP 103 Early Hints Response

The correct way to test is to check for the actual HTTP 103 response (not just headers):

```bash
curl https://<your-hostname>/early_hints -i \
  -H 'sec-fetch-mode: navigate' \
  -H 'user-agent: Chrome/111.0'
```

Expected output:

```
HTTP/2 103
link: <https://fonts.google.com>; rel=preconnect, </main.css>; rel=preload; as=style, </ruxitagentjs_ICA7NVfghqrux_10329260115094563.js>; rel=preload; as=script, </example.css?v=10>; rel=preload; as=script, </small.svg>; rel=preload; as=script

HTTP/2 200
...
```

**Key points**:

- Must include `-i` to see the HTTP 103 interim response
- `sec-fetch-mode: navigate` header signals browser navigation (required for Early Hints)
- `user-agent: Chrome/111.0` identifies as a browser that supports Early Hints
- You should see **HTTP/2 103** first, then **HTTP/2 200**

### Debug with Enhanced Headers

To view EdgeWorker logs, generate an Akamai debug token (valid 10 minutes), then add debug headers to your curl request:

```bash
TOKEN="<generated-token>"

# Standard debug with Early Hints test on path that should trigger hints-reader edgeworker
curl https://<your-hostname>/ -i \
  -H "Pragma: akamai-x-ew-debug" \
  -H "Akamai-EW-Trace: $TOKEN" \
  -H 'sec-fetch-mode: navigate' \
  -H 'user-agent: Chrome/111.0'

# Include EdgeKV sub-requests
curl https://<your-hostname>/ -i \
  -H "Pragma: akamai-x-ew-debug, akamai-x-ew-debug-subs" \
  -H "Akamai-EW-Trace: $TOKEN" \
  -H 'sec-fetch-mode: navigate' \
  -H 'user-agent: Chrome/111.0'
```

Look for these log messages in `x-akamai-edgeworker-onclientrequest-log`:

- `Loaded X static hint(s) from static_hints_config.ts`
- `Found X hint(s) in collection`
- `Set PMUSER_103_HINTS with X total hints`

**Tip**: Check EdgeKV content directly with `manage-hints.sh --show-content`

## Deployment

**Two separate EdgeWorkers** must be deployed independently:

- `hints-updater` (EW ID configured in `hints-updater/package.json`) - Writes to EdgeKV on cache miss
- `hints-reader` (EW ID configured in `hints-reader/package.json`) - Reads from EdgeKV on client request

**Critical deployment constraint**: Akamai does not allow re-activating an already-active version. Always bump `package.json` version before deploying.

**After deployment workflow**:

1. Deploy updated EdgeWorker
2. If one of the "When to reset EdgeKV" cases below applies, clear EdgeKV and purge cache (`manage-hints.sh --full-reset`)
3. Test with cache miss to populate EdgeKV with new format
4. Verify EdgeKV content (`manage-hints.sh --show-content`)

**When to reset EdgeKV**:

- After changing EdgeKV storage schema (e.g., `filename` → `path` migration)
- After modifying logical key extraction logic
- After changing Property Manager match criteria
- When testing version comparison behavior

**Versioning**: Follow semantic versioning (patch for bugs, minor for features, major for breaking changes). Both EdgeWorkers can have independent version numbers.

## EdgeKV Configuration

**CRITICAL**: Token file must use `namespace-<name>` format. Missing the `namespace-` prefix causes: "MISSING ACCESS TOKEN" error.

**Note**: EdgeKV client initialization follows best practices - initialized at global scope (not inside event handlers) for connection reuse and performance.

## Safety Limits

The hints-reader EdgeWorker includes built-in safety checks to prevent misconfiguration issues:

### Maximum Dynamic Hints: 10

**Why**: If Property Manager is misconfigured to match too many resources, EdgeKV could accumulate excessive entries. The hints-reader limits dynamic hints to the first 10 entries. It really doesn't make any sense to send to may hints.

**Behavior when exceeded**:

- Logs warning: `EdgeKV contains X entries, exceeding MAX_DYNAMIC_HINTS (10)`
- Uses only first 10 entries
- Suggests Property Manager misconfiguration

**How to adjust**: Edit `MAX_DYNAMIC_HINTS` constant in `hints-reader/src/main.ts`

### Maximum PMUSER Variable Size: 8KB

**Why**: Akamai's `PMUSER` variables have an 8KB limit. Exceeding this causes Property Manager to fail silently.

**Behavior when exceeded**:

- Logs error: `Merged hints size (X bytes) exceeds MAX_PMUSER_SIZE_BYTES (8000 bytes)`
- Falls back to static hints only
- If static hints also exceed limit, no hints are set

**Calculation**: Uses `TextEncoder` to measure actual byte size (accounts for multi-byte UTF-8 characters)

**Example**:

- 10 hints averaging 150 characters each = ~1500 bytes ✅
- 50 hints averaging 150 characters each = ~7500 bytes ✅
- 60 hints averaging 150 characters each = ~9000 bytes ❌ (exceeds limit)

### Monitoring for Limit Violations

Check EdgeWorker logs (via debug headers) for these warnings:

```bash
# Generate debug token (npm run generate-token in hints-updater or hints-reader), then:
curl -I "https://<your-hostname>/" \
  -H "Pragma: akamai-x-ew-debug" \
  -H "Akamai-EW-Trace: <token>" 2>&1 | \
  grep -E "(exceeding MAX_DYNAMIC_HINTS|exceeds MAX_PMUSER_SIZE_BYTES)"
```

If you see these warnings:

1. Review Property Manager configuration for hints-updater
2. Ensure you're only matching critical resources (not every CSS/JS file)
3. Consider if you need more than 10 dynamic hints (unusual - investigate why)

## Limitations

- **EdgeKV propagation**: ~10 seconds (eventually consistent)
- **PMUSER variable size**: 8KB limit enforced with safety checks
- **Dynamic hints limit**: 10 entries (configurable, prevents misconfiguration)
- **Cache tags**: Max 50 tags per response
- **EdgeWorker tier**: Tier 200 required for EdgeKV access
- **Non-cacheable resources**: Ignored (no benefit to hinting `no-store` assets)

## Conventions

- **Logical keys**: Full path stripped of version info (`/static/example.css?v=10` → key `/static/example.css`)
- **Cache tags**: `early-hints` (global), `hints-<key>` (per-resource)
- **EdgeKV item**: Single `all_hints` object stores all hints with full paths
- **Version precedence**: Last-Modified > serial number > update anyway

## Rules

- Never embed credentials in EdgeWorker code
- Never skip version comparison in hints-updater
- Always configure Property Manager triggers carefully
- Only hint cacheable resources
- Keep static hints minimal (under 8KB combined)
- Test with debug headers before production deployment

## Debugging Approach

- Before making code changes to fix a perceived bug, first confirm the bug actually exists by testing with multiple methods (e.g., different curl flags, browser DevTools, programmatic checks).
- Prefer verifying current behavior before assuming something is broken.
