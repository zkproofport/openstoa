import i18n from 'i18next';
import { useTranslation } from 'react-i18next';

import enResources from './locales/en.json';
import koResources from './locales/ko.json';

// Merge OpenStoa-specific bundles into the shared i18next instance that the
// host has already initialised (resolved from host node_modules via Metro).
// Using deep-merge (true, true) so we don't overwrite host keys.
i18n.addResourceBundle('en', 'translation', enResources, true, true);
i18n.addResourceBundle('ko', 'translation', koResources, true, true);

export function useOpenStoaTranslation() {
  return useTranslation('translation');
}
