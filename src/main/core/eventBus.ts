/**
 * Event bus — spec §3.5. Small typed emitter; producers never poll.
 * Listener exceptions are isolated so one bad subscriber cannot break the producer.
 */
export class EventBus<E extends { type: string }> {
  private listeners = new Map<string, Set<(e: E) => void>>();
  private anyListeners = new Set<(e: E) => void>();

  on<K extends E['type']>(type: K, fn: (e: Extract<E, { type: K }>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    const wrapped = (e: E): void => {
      try {
        fn(e as Extract<E, { type: K }>);
      } catch (err) {
        console.error(`event listener error for "${type}":`, err);
      }
    };
    set.add(wrapped);
    this.listeners.set(type, set);
    return () => {
      set.delete(wrapped);
    };
  }

  onAny(fn: (e: E) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  emit(event: E): void {
    const set = this.listeners.get(event.type);
    if (set) for (const fn of [...set]) fn(event);
    for (const fn of [...this.anyListeners]) {
      try {
        fn(event);
      } catch (err) {
        console.error('wildcard listener error:', err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}
