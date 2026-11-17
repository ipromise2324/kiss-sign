/** The languages a signer can read the HTML report and the verify page in. English is the default. */
export const LANGUAGES = ['en', 'zh-TW'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

export const isLanguage = (raw: unknown): raw is Language => LANGUAGES.includes(raw as Language);

/** Each language by its English name, for the terminal. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { en: 'English', 'zh-TW': 'Traditional Chinese' };

/** Each language's `lang` attribute on an HTML page. */
export const HTML_LANG: Readonly<Record<Language, string>> = { en: 'en', 'zh-TW': 'zh-Hant' };
