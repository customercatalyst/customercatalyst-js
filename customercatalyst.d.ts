// Type definitions for the CustomerCatalyst browser SDK.
// The SDK ships as a single plain-JS file loaded via <script>; these types are
// hand-maintained to match its public surface. Keep them in step with
// customercatalyst.js.

export interface IdentifyOptions {
  /** Customer ID from your dashboard. Required. Max 255 code points. */
  customerId: string;
  /** Optional display name for the customer. */
  customerName?: string;
}

/** Read-only snapshot of one API key's queue, from `stats`. */
export interface Stats {
  /** Events for this API key currently waiting to send. */
  queued: number;
  /** Events lost for this key (rejected batch, retry ceiling, or a stop). */
  droppedEvents: number;
  /** Batches lost for this key. */
  droppedBatches: number;
}

export declare class CustomerCatalyst {
  /**
   * Construct an instance for one organization API key. Prefer the script-tag
   * install (which builds `window.customercatalyst` for you); use the
   * constructor for multiple instances, a runtime-known key, or a bundler.
   */
  constructor(apiKey: string);

  /** `true` once a fatal error has stopped this key; `track()` is then ignored. */
  readonly isStopped: boolean;

  /** Queue snapshot for this key. */
  readonly stats: Stats;

  /** Identify the current customer. Must be called before `track()`. */
  identify(options: IdentifyOptions): void;

  /**
   * Track a usage event. `value` defaults to 1 and is the quantity recorded,
   * not a multiplier. `metadata` is arbitrary JSON-serialisable context.
   */
  track(eventType: string, value?: number, metadata?: Record<string, unknown>): void;

  /** Flush the queue and resolve once it drains (or after a 5s ceiling). */
  flush(): Promise<void>;

  /** Resume the same key after a temporary fatal error. */
  restart(): void;

  /**
   * What the script tag calls to build `window.customercatalyst` from its
   * `api-key` attribute. Idempotent. Returns the instance, or null if there is
   * no usable `api-key` on the page.
   */
  static init(): CustomerCatalyst | null;

  /** Global switch: verbose console logging for every instance on the page. */
  static debug: boolean;
}

declare global {
  interface Window {
    CustomerCatalyst: typeof CustomerCatalyst;
    /** The auto-init instance, present when a <script api-key="..."> tag ran. */
    customercatalyst?: CustomerCatalyst;
  }
}
