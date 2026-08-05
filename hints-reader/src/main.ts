/**
 * EdgeWorker: hints-reader
 *
 * Purpose: Read-only EdgeWorker that merges static HTTP 103 Early Hints with
 * dynamic hints stored in EdgeKV, then sets a PMUSER variable for Property Manager
 * to emit the 103 response before the final response.
 *
 * Trigger: onClientRequest (only when matched in Property Manager - typically HTML pages)
 *
 * Flow:
 * 1. Start with predefined static hints (minimal set to leave room for dynamic hints)
 * 2. Fetch all hints from EdgeKV (single lookup of "all_hints" item)
 * 3. Build hint strings from stored paths (e.g., "/static/example.css?v=10")
 * 4. Merge static and dynamic hints into a single Link header string
 * 5. Set PMUSER variable for Property Manager to emit as 103 Early Hints
 *
 * Important:
 * - Never block or error the request if EdgeKV lookup fails - fall back to static hints only
 * - The 103 response must be sent BEFORE the final response (handled by Property Manager)
 * - Follow RFC 8297 for Early Hints format: "<url>; rel=preload; as=type"
 * - Make sure to only start this script where it makes sense like on HTML pages to avoid unnecessary overhead
 */

import { EdgeKV } from "./edgekv.js";
import { logger } from "log";
import { staticHints as staticHintsConfig } from "./static_hints_config.js";
import { TextEncoder } from "encoding";

// EdgeKV configuration
// REQUIRED: Replace with your own EdgeKV namespace (must already exist).
// Must match the namespace used in hints-updater/src/main.ts.
const EDGEKV_NAMESPACE = "jgrinwiskv";
const EDGEKV_GROUP = "earlyHints";

// Property Manager User-Defined Variable (PMUSER) name
// Property Manager will read this variable and emit it as the 103 Early Hints response
const PMUSER_103_HINTS: string = "PMUSER_103_HINTS";

// Safety limits to prevent misconfiguration issues
// Max dynamic hints prevents excessive EdgeKV entries from overwhelming the response
const MAX_DYNAMIC_HINTS = 10;
// Max PMUSER variable size (8KB limit) - leave some headroom for encoding
// Akamai documentation: https://techdocs.akamai.com/edgeworkers/docs/request-object#setvariable
const MAX_PMUSER_SIZE_BYTES = 8000; // 8KB limit with 192 byte safety margin

/**
 * Validates a hint string follows RFC 8297 format
 * Valid formats:
 * - "<url>; rel=preconnect"
 * - "<url>; rel=preload; as=type"
 *
 * @param hint - The hint string to validate
 * @returns true if valid, false otherwise
 */
function isValidHint(hint: string): boolean {
  // Must start with < and contain >
  if (!hint.startsWith("<") || !hint.includes(">")) {
    return false;
  }

  // Must have rel= parameter
  if (!hint.includes("rel=")) {
    return false;
  }

  // rel must be preload or preconnect
  const hasPreload = hint.includes("rel=preload");
  const hasPreconnect = hint.includes("rel=preconnect");

  if (!hasPreload && !hasPreconnect) {
    return false;
  }

  // If rel=preload, must have as= parameter
  if (hasPreload && !hint.includes("as=")) {
    return false;
  }

  return true;
}

/**
 * Load and validate static hints from configuration file
 * Falls back to empty string if validation fails
 *
 * @returns Comma-separated validated hints string
 */
function loadStaticHints(): string {
  try {
    if (!staticHintsConfig || !Array.isArray(staticHintsConfig)) {
      logger.error(
        "static_hints_config.ts: Invalid format - must export an array",
      );
      return "";
    }

    const validHints: string[] = [];
    const invalidHints: string[] = [];

    for (const hint of staticHintsConfig) {
      if (typeof hint !== "string") {
        invalidHints.push(`[non-string value: ${typeof hint}]`);
        continue;
      }

      if (!isValidHint(hint)) {
        invalidHints.push(hint);
        continue;
      }

      validHints.push(hint);
    }

    if (invalidHints.length > 0) {
      logger.error(
        `static_hints_config.ts: ${invalidHints.length} invalid hint(s) skipped: ${invalidHints.join(" | ")}`,
      );
    }

    if (validHints.length === 0) {
      logger.error("static_hints_config.ts: No valid hints found");
      return "";
    }

    logger.log(
      `Loaded ${validHints.length} static hint(s) from static_hints_config.ts`,
    );
    return validHints.join(", ");
  } catch (error) {
    logger.error(
      `Failed to load static_hints_config.ts: ${JSON.stringify(error)}`,
    );
    return "";
  }
}

// Load static hints from configuration file at module initialization
// Customer can edit static_hints_config.ts without touching main.ts
// Format follows RFC 8297: "<url>; rel=preload|preconnect; as=type"
const STATIC_HINTS = loadStaticHints();

// Initialize EdgeKV client
// Authentication token should be configured in edgekv_tokens.js (not hardcoded here)
const edgeKv: EdgeKV = new EdgeKV({
  namespace: EDGEKV_NAMESPACE,
  group: EDGEKV_GROUP,
});

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
 * Build a hint string from path following RFC 8297
 *
 * @param path - The full path to create a hint for
 * @returns Link header entry in RFC 8297 format
 */
function buildHintFromPath(path: string): string {
  // Extract file extension to determine the 'as' type (from path, ignoring query string)
  const pathWithoutQuery = path.split("?")[0];
  const extension = pathWithoutQuery.split(".").pop()?.toLowerCase() || "";
  let asType = "script";

  if (extension === "css") {
    asType = "style";
  } else if (extension === "js") {
    asType = "script";
  } else if (
    extension === "woff" ||
    extension === "woff2" ||
    extension === "ttf"
  ) {
    asType = "font";
  } else if (
    extension === "png" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "gif" ||
    extension === "webp" ||
    extension === "avif" ||
    extension === "svg"
  ) {
    asType = "image";
  }

  return `<${path}>; rel=preload; as=${asType}`;
}

/**
 * Merge static and dynamic hints into a single Link header string
 *
 * @param staticHints - Predefined static hints
 * @param dynamicHints - Dynamic hints from EdgeKV (may be empty)
 * @returns Comma-separated Link header value
 */
function mergeHints(staticHints: string, dynamicHints: string): string {
  const parts = [staticHints, dynamicHints]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return parts.join(", ");
}

/**
 * Main handler: onClientRequest
 *
 * Called for every incoming request. Fetches ALL dynamic hints from EdgeKV (stored as
 * a single comma-separated string) and merges with static hints, then sets a PMUSER
 * variable for Property Manager.
 */
export async function onClientRequest(
  request: EW.IngressClientRequest,
): Promise<void> {
  const staticHints = STATIC_HINTS;
  const dynamicHintsList: string[] = [];

  try {
    logger.log(`Fetching all hints from EdgeKV key: ${ALL_HINTS_KEY}`);

    // Single EdgeKV lookup to get all hints
    const allHints =
      (await edgeKv.getJson<EdgeKVAllHints>({
        item: ALL_HINTS_KEY,
        default_value: {},
      })) || {};

    const keys = Object.keys(allHints);
    logger.log(`Found ${keys.length} hint(s) in collection`);

    // Check if we have too many entries (possible misconfiguration)
    if (keys.length > MAX_DYNAMIC_HINTS) {
      logger.warn(
        `EdgeKV contains ${keys.length} entries, exceeding MAX_DYNAMIC_HINTS (${MAX_DYNAMIC_HINTS}). ` +
          `This may indicate Property Manager misconfiguration. Only first ${MAX_DYNAMIC_HINTS} will be used.`,
      );
    }

    // Build hint strings from each entry (limited to MAX_DYNAMIC_HINTS)
    const keysToProcess = keys.slice(0, MAX_DYNAMIC_HINTS);
    for (const key of keysToProcess) {
      const entry = allHints[key];
      if (entry && entry.path) {
        const hint = buildHintFromPath(entry.path);
        dynamicHintsList.push(hint);
        logger.log(`Loaded hint for key "${key}": ${hint}`);
      }
    }

    if (keys.length > MAX_DYNAMIC_HINTS) {
      logger.log(
        `Successfully loaded ${dynamicHintsList.length} dynamic hint(s) (limited from ${keys.length} total entries)`,
      );
    } else {
      logger.log(
        `Successfully loaded ${dynamicHintsList.length} dynamic hint(s)`,
      );
    }
  } catch (error) {
    // IMPORTANT: Never block the request if EdgeKV lookup fails
    // Fall back to static hints only and log the error for troubleshooting
    logger.error(
      `Error fetching dynamic hints from EdgeKV: ${JSON.stringify(error)}`,
    );
    logger.error(`Proceeding with static hints only`);
  }

  // Merge static and dynamic hints
  const dynamicHints = dynamicHintsList.join(", ");
  const mergedHints = mergeHints(staticHints, dynamicHints);

  if (mergedHints) {
    // Check PMUSER variable size limit (8KB)
    // Use TextEncoder for accurate UTF-8 byte counting
    const encoder = new TextEncoder();
    const mergedHintsSize = encoder.encode(mergedHints).length;

    if (mergedHintsSize > MAX_PMUSER_SIZE_BYTES) {
      logger.error(
        `Merged hints size (${mergedHintsSize} bytes) exceeds MAX_PMUSER_SIZE_BYTES (${MAX_PMUSER_SIZE_BYTES} bytes). ` +
          `This will cause Property Manager to fail. Using static hints only. ` +
          `Check Property Manager configuration - too many resources are being tracked.`,
      );

      // Fall back to static hints only
      const staticHintsSize = encoder.encode(staticHints).length;
      if (staticHintsSize <= MAX_PMUSER_SIZE_BYTES) {
        request.setVariable(PMUSER_103_HINTS, staticHints);
        logger.log(
          `Set ${PMUSER_103_HINTS} with static hints only (${staticHintsSize} bytes) due to size limit`,
        );
      } else {
        logger.error(
          `Even static hints (${staticHintsSize} bytes) exceed size limit. No hints will be set.`,
        );
      }
    } else {
      // Size is within limits - set the merged hints
      request.setVariable(PMUSER_103_HINTS, mergedHints);
      const hintCount = mergedHints.split(",").length;
      logger.log(
        `Set ${PMUSER_103_HINTS} with ${hintCount} total hints (${mergedHintsSize} bytes)`,
      );
    }
  }
}
