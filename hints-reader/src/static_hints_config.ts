/**
 * Static hints configuration
 *
 * Customer can edit this file to add/remove static hints without touching main.ts
 *
 * Format follows RFC 8297:
 * - "<url>; rel=preconnect" - for early connection setup
 * - "<url>; rel=preload; as=type" - for resource preloading
 *
 * Valid 'as' types: script, style, font, image, fetch, document
 *
 * Examples:
 * - "<https://fonts.google.com>; rel=preconnect"
 * - "</main.css>; rel=preload; as=style"
 * - "</app.js>; rel=preload; as=script"
 * - "</font.woff2>; rel=preload; as=font"
 */

export const staticHints = [
  "<https://fonts.google.com>; rel=preconnect",
  "</main.css>; rel=preload; as=style",
  "</app.js>; rel=preload; as=script",
];
