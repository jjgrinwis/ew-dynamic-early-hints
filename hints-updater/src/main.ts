/**
 * EdgeWorker: hints-updater
 *
 * Purpose: Write-only EdgeWorker that captures responses from origin on cache miss,
 * extracts dynamic hint candidates, and stores them in EdgeKV with Last-Modified
 * tracking to ensure only newer versions overwrite existing entries.
 *
 * Trigger: onOriginResponse (only on cache miss - configured in Property Manager)
 *
 * Flow:
 * 1. Verify origin returned 200 OK (only cache successful responses)
 * 2. Get full URL path from request.url (e.g., "/static/example.css?v=10")
 * 3. Extract logical key from URL (e.g., "/js/ruxitagentjs_123.js" → "/js/ruxitagentjs")
 * 4. Get Last-Modified header from origin response
 * 5. Read existing EdgeKV entry for this key (if any)
 * 6. Compare Last-Modified timestamps - only write if incoming is newer
 * 7. If newer: write to EdgeKV and set Edge-Cache-Tag header for purging
 *
 * Critical guards:
 * - MUST compare Last-Modified before writing to prevent cache miss on stale URL
 *   from overwriting a newer EdgeKV entry with older data
 * - This happens when a cold edge POP serves an old page reference, causing a
 *   cache miss on an outdated URL that's older than what's already in EdgeKV
 *
 * Cache tags:
 * - "early-hints" - broad tag for all managed entries (used in full reset)
 * - "hints-<key>" - specific tag per logical key (used for targeted purge)
 */

import { EdgeKV } from "./edgekv.js";
import { logger } from "log";

// EdgeKV configuration
// REQUIRED: Replace with your own EdgeKV namespace (must already exist).
// Must match the namespace used in hints-reader/src/main.ts.
const EDGEKV_NAMESPACE = "jgrinwiskv";
const EDGEKV_GROUP = "earlyHints";

/**
 * EdgeKV value structure for a single hint entry
 */
interface EdgeKVHintValue {
  path: string; // Full path including query string (e.g., "/static/image.svg?v=10")
  lastModified: string | null;
}

/**
 * EdgeKV storage structure - all hints in a single item
 * Key is the logical key (e.g., "ruxitagentjs", "example.css")
 * Value is the hint metadata
 */
interface EdgeKVAllHints {
  [key: string]: EdgeKVHintValue;
}

// Single EdgeKV item key that stores all hints
const ALL_HINTS_KEY = "all_hints";

/**
 * Compare two Last-Modified dates or fall back to serial number comparison
 *
 * @param incomingLastModified - Last-Modified header from current origin response
 * @param incomingPath - Full path from current request
 * @param existingLastModified - Last-Modified from existing EdgeKV entry
 * @param existingPath - Full path from existing EdgeKV entry
 * @returns true if incoming should replace existing
 */
function shouldUpdate(
  incomingLastModified: string | null,
  incomingPath: string,
  existingLastModified: string | null,
  existingPath: string
): boolean {
  // If both have Last-Modified, compare dates
  if (incomingLastModified && existingLastModified) {
    try {
      const incomingDate = new Date(incomingLastModified);
      const existingDate = new Date(existingLastModified);

      // Only update if incoming is newer
      const shouldReplace = incomingDate > existingDate;
      logger.log(`Last-Modified comparison: incoming ${incomingLastModified} vs existing ${existingLastModified} = ${shouldReplace ? 'UPDATE' : 'SKIP'}`);
      return shouldReplace;
    } catch (error) {
      logger.warn(`Failed to parse Last-Modified dates: ${JSON.stringify(error)}`);
      // Fall through to serial comparison
    }
  }

  // Fallback: compare serial numbers
  const incomingSerial = extractSerial(incomingPath);
  const existingSerial = extractSerial(existingPath);

  if (incomingSerial && existingSerial) {
    try {
      const shouldReplace = BigInt(incomingSerial) > BigInt(existingSerial);
      logger.log(`Serial comparison: incoming ${incomingSerial} vs existing ${existingSerial} = ${shouldReplace ? 'UPDATE' : 'SKIP'}`);
      return shouldReplace;
    } catch (error) {
      logger.warn(`Failed to compare serials: ${JSON.stringify(error)}`);
    }
  }

  // If we can't determine, default to updating (replace existing)
  logger.warn(`Cannot determine version order, defaulting to UPDATE`);
  return true;
}

/**
 * Extract serial number from path or query string
 * Handles patterns like:
 * - "/static/ruxitagentjs_ABC_123456.js" → "123456"
 * - "/static/integrations.css?v=202607214303" → "202607214303"
 *
 * @param path - The full path (with optional query string) to extract serial from
 * @returns Serial number string or null
 */
function extractSerial(path: string): string | null {
  // First try query string pattern: ?v=123456 or &v=123456
  const queryMatch = path.match(/[?&]v=(\d+)/);
  if (queryMatch) {
    return queryMatch[1];
  }

  // Fallback: match pattern in filename: name_serial.ext or name_prefix_serial.ext
  const filenameMatch = path.match(/_(\d+)\.[^.?]+/);
  return filenameMatch ? filenameMatch[1] : null;
}

// Initialize EdgeKV client
// Authentication token should be configured in edgekv_tokens.js (not hardcoded here)
const edgeKv: EdgeKV = new EdgeKV({
  namespace: EDGEKV_NAMESPACE,
  group: EDGEKV_GROUP,
});

/**
 * Build a hint string for a file following RFC 8297
 *
 * @param path - The full path to create a hint for
 * @returns Link header entry in RFC 8297 format
 */
function buildHint(path: string): string {
  // Extract file extension to determine the 'as' type (from path, ignoring query string)
  const pathWithoutQuery = path.split('?')[0];
  const extension = pathWithoutQuery.split('.').pop()?.toLowerCase() || '';
  let asType = 'script'; // Default to script

  if (extension === 'css') {
    asType = 'style';
  } else if (extension === 'js') {
    asType = 'script';
  } else if (extension === 'woff' || extension === 'woff2' || extension === 'ttf') {
    asType = 'font';
  } else if (extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'gif' || extension === 'webp' || extension === 'svg') {
    asType = 'image';
  }

  // Build the Link header entry following RFC 8297
  // Format: "<url>; rel=preload; as=type"
  return `<${path}>; rel=preload; as=${asType}`;
}

/**
 * Extract a logical key (pattern name) from path for hint deduplication
 * Handles patterns:
 * - /static/<name>_<serial>.<extension> → "/static/name"
 * - /static/<name>.<extension>?v=<serial> → "/static/name.extension"
 * - Static files → full path without query string
 *
 * @param path - The full path (with optional query string) to extract key from
 * @returns Logical key for deduplication
 */
function extractKeyFromPath(path: string): string {
  // Strip query string first for key extraction
  const withoutQuery = path.split('?')[0];

  // Get the filename part to check for underscore patterns
  const filename = withoutQuery.split('/').pop() || '';
  const underscoreIndex = filename.indexOf('_');

  if (underscoreIndex > 0) {
    // Dynamic pattern with underscore: return path up to directory + everything before the first underscore
    // Example: "/static/ruxitagentjs_ICA7NVfghqrux_10329260115094560.js" → "/static/ruxitagentjs"
    const directory = withoutQuery.substring(0, withoutQuery.lastIndexOf('/') + 1);
    const keyPart = filename.substring(0, underscoreIndex);
    return directory + keyPart;
  } else {
    // Static entry or query-string versioned: use the full path without query string as the key
    // Examples:
    // - "/static/main.css" → "/static/main.css"
    // - "/static/integrations.css?v=202607214303" → "/static/integrations.css"
    return withoutQuery;
  }
}

/**
 * Main handler: onOriginResponse
 *
 * Called only on cache miss (configured in Property Manager).
 * Reads ALL current hints from EdgeKV, adds/updates this file's hint, writes back.
 *
 * IMPORTANT: Property Manager should be configured to only trigger this EdgeWorker
 * for paths that match the expected pattern (e.g., *.js, *.css for hint candidates)
 */
export async function onOriginResponse(
  request: EW.EgressOriginRequest,
  response: EW.EgressOriginResponse
): Promise<void> {
  // Only process successful responses
  if (response.status !== 200) {
    logger.log(`Skipping non-200 response: ${response.status} for path: ${request.path}`);
    return;
  }

  // Get full URL path (includes path + query string)
  const fullPath = request.url;

  if (!fullPath) {
    logger.log(`Could not extract URL from request`);
    return;
  }

  logger.log(`Processing cache miss for URL: ${fullPath}`);

  // Get Last-Modified header from origin response
  const lastModified = response.getHeader('Last-Modified')?.[0] || null;
  logger.log(`Last-Modified from origin: ${lastModified || '(not provided)'}`);

  // Build the logical key for this path
  const logicalKey = extractKeyFromPath(fullPath);
  logger.log(`Logical key: ${logicalKey}`);

  try {
    // Read the entire hints collection (single EdgeKV lookup)
    logger.log(`Reading all hints from EdgeKV key: ${ALL_HINTS_KEY}`);
    const allHints = await edgeKv.getJson<EdgeKVAllHints>({
      item: ALL_HINTS_KEY,
      default_value: {}
    }) || {};

    // Check if we already have an entry for this logical key
    const existingEntry = allHints[logicalKey] || null;
    logger.log(`Existing entry for ${logicalKey}: ${existingEntry ? JSON.stringify(existingEntry) : '(none)'}`);

    // Determine if we should update based on Last-Modified or serial number
    if (existingEntry) {
      const shouldReplace = shouldUpdate(
        lastModified,
        fullPath,
        existingEntry.lastModified,
        existingEntry.path
      );

      if (!shouldReplace) {
        logger.log(`Skipping update: existing entry is newer or equal (${existingEntry.path})`);
        // Still set cache tag even though we're not updating
        response.setHeader('Edge-Cache-Tag', `early-hints,hints-${logicalKey}`);
        return;
      }
    }

    // Update the entry for this logical key
    allHints[logicalKey] = {
      path: fullPath,
      lastModified: lastModified
    };

    logger.log(`Updating hints collection with ${logicalKey}: ${JSON.stringify(allHints[logicalKey])}`);
    logger.log(`Total hints in collection: ${Object.keys(allHints).length}`);

    // Write the entire collection back (single EdgeKV write)
    edgeKv.putJsonNoWait({
      item: ALL_HINTS_KEY,
      value: allHints
    });

    logger.log(`Successfully queued EdgeKV write for ${ALL_HINTS_KEY}`);

  } catch (error) {
    logger.error(`Error updating EdgeKV hints: ${JSON.stringify(error)}`);
  }

  // Set Edge-Cache-Tag response header for Fast Purge capability
  const cacheTags = `early-hints,hints-${logicalKey}`;

  try {
    response.setHeader('Edge-Cache-Tag', cacheTags);
    logger.log(`Set Edge-Cache-Tag header: ${cacheTags}`);
  } catch (error) {
    logger.error(`Error setting Edge-Cache-Tag header: ${JSON.stringify(error)}`);
  }
}
