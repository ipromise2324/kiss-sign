/** The languages a signer can read the HTML report and the verify page in. English is the default. */
export const LANGUAGES = ['en', 'zh-TW'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

export const isLanguage = (raw: unknown): raw is Language => LANGUAGES.includes(raw as Language);

/** Each language by its English name, for the terminal. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { en: 'English', 'zh-TW': 'Traditional Chinese' };

/** Each language's `lang` attribute on an HTML page. */
export const HTML_LANG: Readonly<Record<Language, string>> = { en: 'en', 'zh-TW': 'zh-Hant' };

/** Text an author wrote for the signer, in one language or more: never empty. */
export type Prose = Readonly<Partial<Record<Language, string>>>;

/** `prose` in `language`, else in the first language it holds. */
export const say = (prose: Prose, language: Language): string => prose[language] ?? (LANGUAGES.map((held) => prose[held]).find((text) => text !== undefined) as string);

/** Whether `raw` is prose keyed by language: an object whose keys are languages alone, at least one. */
export const isProse = (raw: unknown): raw is Record<Language, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length > 0 && Object.keys(raw).every((key) => isLanguage(key));
