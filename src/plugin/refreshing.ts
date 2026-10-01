// Values that are slow to fetch and seldom change, such as the names of BB's
// machine variables: kept per key, and once stale, refreshed in the
// background while callers keep getting the last value.

export interface RefreshingOptions<T> {
  readonly load: (key: string) => Promise<T>;
  /** How long a value is fresh. The first get after that refreshes it in the background. */
  readonly freshMs: number;
  /** A refresh in the background failed. The last value stays until a get finds it stale again. */
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
}

interface Entry<T> {
  value: Promise<T>;
  /** When the value arrived, or the last refresh failed. Null while the first fetch runs. */
  at: number | null;
  refreshing: boolean;
}

export class Refreshing<T> {
  readonly #options: RefreshingOptions<T>;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(options: RefreshingOptions<T>) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** The value for `key`. Callers wait only for the first fetch; when it fails, the next get tries again. */
  get(key: string): Promise<T> {
    const entry = this.#entries.get(key);
    if (!entry) {
      const first: Entry<T> = { value: this.#options.load(key), at: null, refreshing: false };
      this.#entries.set(key, first);
      first.value.then(
        () => (first.at = this.#now()),
        () => {
          if (this.#entries.get(key) === first) this.#entries.delete(key);
        },
      );
      return first.value;
    }
    if (entry.at !== null && !entry.refreshing && this.#now() - entry.at >= this.#options.freshMs) {
      entry.refreshing = true;
      this.#options.load(key).then(
        (value) => {
          entry.value = Promise.resolve(value);
          entry.at = this.#now();
          entry.refreshing = false;
        },
        (error) => {
          entry.at = this.#now();
          entry.refreshing = false;
          this.#options.onError(error);
        },
      );
    }
    return entry.value;
  }
}
