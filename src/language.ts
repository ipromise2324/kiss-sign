import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * The language a command prints in: the one its last `--language` names, as parseArgs takes, else the `language` of the
 * config in `home`, else English, so a command run before any config exists prints English. It reads only that field,
 * so it runs before any package is loaded.
 */
export function commandLanguage(argv: readonly string[], home: string): Language {
  const at = argv.findLastIndex((arg) => arg === '--language' || arg.startsWith('--language='));
  const arg = argv[at];
  const flag = arg === '--language' ? argv[at + 1] : arg?.slice('--language='.length);
  if (isLanguage(flag)) return flag;
  try {
    const stored = (JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { language?: unknown } | null)?.language;
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}
