/**
 * Type definitions for Akamai EdgeKV JavaScript helper library
 *
 * This file provides TypeScript definitions for the EdgeKV helper library (edgekv.js)
 * which is plain JavaScript with no built-in type definitions.
 *
 * Documentation: https://techdocs.akamai.com/edgekv/docs/library-helper-methods
 */

/**
 * EdgeKV initialization options
 */
export interface EdgeKVOptions {
  /**
   * The EdgeKV namespace to use
   */
  namespace: string;

  /**
   * The group identifier within the namespace
   */
  group: string;
}

/**
 * Options for EdgeKV read operations
 */
export interface GetOptions<T = any> {
  /**
   * The item key to retrieve
   */
  item: string;

  /**
   * Default value to return if the item doesn't exist
   */
  default_value?: T | null;
}

/**
 * Options for EdgeKV write operations
 */
export interface PutOptions {
  /**
   * The item key to write
   */
  item: string;

  /**
   * The value to write (will be JSON-stringified for putJson)
   */
  value: any;
}

/**
 * EdgeKV client for interacting with Akamai's key-value store
 *
 * The EdgeKV helper library provides methods to read from and write to EdgeKV.
 * Authentication is handled via tokens configured in edgekv_tokens.js.
 */
export class EdgeKV {
  /**
   * Create a new EdgeKV client instance
   *
   * @param options - Configuration options including namespace and group
   */
  constructor(options: EdgeKVOptions);

  /**
   * Read a text value from EdgeKV (blocking)
   *
   * @param options - Read options including item key and optional default value
   * @returns Promise resolving to the text value or default value if not found
   */
  getText(options: GetOptions<string>): Promise<string | null>;

  /**
   * Read a JSON value from EdgeKV (blocking)
   *
   * The value is automatically parsed from JSON into a JavaScript object.
   *
   * @param options - Read options including item key and optional default value
   * @returns Promise resolving to the parsed JSON object or default value if not found
   */
  getJson<T = any>(options: GetOptions<T>): Promise<T | null>;

  /**
   * Write a text value to EdgeKV (blocking)
   *
   * This method waits for the write operation to complete before returning.
   * Use putTextNoWait for non-blocking writes.
   *
   * @param options - Write options including item key and text value
   * @returns Promise resolving when the write completes
   */
  putText(options: PutOptions): Promise<void>;

  /**
   * Write a text value to EdgeKV (non-blocking)
   *
   * This method queues the write operation and returns immediately without waiting.
   * Use this in onOriginResponse or other hot paths to avoid adding latency.
   *
   * @param options - Write options including item key and text value
   */
  putTextNoWait(options: PutOptions): void;

  /**
   * Write a JSON value to EdgeKV (blocking)
   *
   * The value is automatically stringified to JSON before writing.
   * This method waits for the write operation to complete before returning.
   * Use putJsonNoWait for non-blocking writes.
   *
   * @param options - Write options including item key and object value
   * @returns Promise resolving when the write completes
   */
  putJson(options: PutOptions): Promise<void>;

  /**
   * Write a JSON value to EdgeKV (non-blocking)
   *
   * The value is automatically stringified to JSON before writing.
   * This method queues the write operation and returns immediately without waiting.
   * Use this in onOriginResponse or other hot paths to avoid adding latency.
   *
   * @param options - Write options including item key and object value
   */
  putJsonNoWait(options: PutOptions): void;

  /**
   * Delete an item from EdgeKV (blocking)
   *
   * @param options - Options with the item key to delete
   * @returns Promise resolving when the delete completes
   */
  delete(options: { item: string }): Promise<void>;
}
