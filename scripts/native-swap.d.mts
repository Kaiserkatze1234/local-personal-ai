/** Types for scripts/native-swap.mjs (runtime module stays plain JS for predev). */
export interface SwapOptions {
  /** node_modules/better-sqlite3/build/Release/better_sqlite3.node */
  pkgBin: string;
  /** scratch path for the byte-exact backup (removed afterwards, in native/) */
  backup: string;
  /** run the actual fetch/rebuild; true = command succeeded */
  produce: () => boolean;
  /** copy pkgBin into the native cache — called while the PRODUCED file is on disk */
  stash: (producedPkgBin: string) => void;
}

/** @see scripts/native-swap.mjs — returns true only when a usable, changed binding was stashed. */
export declare function swapWithProducedBinding(opts: SwapOptions): boolean;
export declare function shaFile(f: string): string;
