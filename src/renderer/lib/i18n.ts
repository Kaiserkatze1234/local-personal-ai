/**
 * UI-chrome translation (§47 language). Reads the live config from the store;
 * components call L('English source') — dictionary falls back to the source
 * string, so untranslated UI stays readable in any language.
 */
import { tr } from '../../shared/i18n.js';
import { useStore } from '../state/store.js';

export function L(en: string): string {
  return tr(useStore.getState().config?.general.language ?? 'en', en);
}
