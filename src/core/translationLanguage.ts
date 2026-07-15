export const TRANSLATION_LANGUAGES = [
  { code: 'en', nativeName: 'English', promptName: 'English' },
  { code: 'zh-Hans', nativeName: '简体中文', promptName: 'Simplified Chinese' },
  { code: 'zh-Hant', nativeName: '繁體中文', promptName: 'Traditional Chinese' },
  { code: 'es', nativeName: 'Español', promptName: 'Spanish' },
  { code: 'ja', nativeName: '日本語', promptName: 'Japanese' },
  { code: 'ko', nativeName: '한국어', promptName: 'Korean' },
  { code: 'fr', nativeName: 'Français', promptName: 'French' },
  { code: 'de', nativeName: 'Deutsch', promptName: 'German' },
  { code: 'pt', nativeName: 'Português', promptName: 'Portuguese' },
  { code: 'it', nativeName: 'Italiano', promptName: 'Italian' },
  { code: 'ru', nativeName: 'Русский', promptName: 'Russian' },
  { code: 'ar', nativeName: 'العربية', promptName: 'Arabic' },
  { code: 'hi', nativeName: 'हिन्दी', promptName: 'Hindi' },
  { code: 'bn', nativeName: 'বাংলা', promptName: 'Bengali' },
  { code: 'ur', nativeName: 'اردو', promptName: 'Urdu' },
  { code: 'id', nativeName: 'Bahasa Indonesia', promptName: 'Indonesian' },
  { code: 'ms', nativeName: 'Bahasa Melayu', promptName: 'Malay' },
  { code: 'vi', nativeName: 'Tiếng Việt', promptName: 'Vietnamese' },
  { code: 'th', nativeName: 'ไทย', promptName: 'Thai' },
  { code: 'tr', nativeName: 'Türkçe', promptName: 'Turkish' },
  { code: 'pl', nativeName: 'Polski', promptName: 'Polish' },
  { code: 'nl', nativeName: 'Nederlands', promptName: 'Dutch' },
  { code: 'uk', nativeName: 'Українська', promptName: 'Ukrainian' },
  { code: 'fa', nativeName: 'فارسی', promptName: 'Persian' },
  { code: 'he', nativeName: 'עברית', promptName: 'Hebrew' },
  { code: 'sv', nativeName: 'Svenska', promptName: 'Swedish' },
  { code: 'nb', nativeName: 'Norsk bokmål', promptName: 'Norwegian Bokmål' },
  { code: 'da', nativeName: 'Dansk', promptName: 'Danish' },
  { code: 'fi', nativeName: 'Suomi', promptName: 'Finnish' },
  { code: 'el', nativeName: 'Ελληνικά', promptName: 'Greek' },
  { code: 'cs', nativeName: 'Čeština', promptName: 'Czech' },
  { code: 'ro', nativeName: 'Română', promptName: 'Romanian' },
  { code: 'hu', nativeName: 'Magyar', promptName: 'Hungarian' },
  { code: 'sk', nativeName: 'Slovenčina', promptName: 'Slovak' },
  { code: 'bg', nativeName: 'Български', promptName: 'Bulgarian' },
  { code: 'hr', nativeName: 'Hrvatski', promptName: 'Croatian' },
  { code: 'sr', nativeName: 'Српски', promptName: 'Serbian' },
  { code: 'sl', nativeName: 'Slovenščina', promptName: 'Slovenian' },
  { code: 'lt', nativeName: 'Lietuvių', promptName: 'Lithuanian' },
  { code: 'lv', nativeName: 'Latviešu', promptName: 'Latvian' },
  { code: 'et', nativeName: 'Eesti', promptName: 'Estonian' },
  { code: 'ca', nativeName: 'Català', promptName: 'Catalan' },
  { code: 'fil', nativeName: 'Filipino', promptName: 'Filipino' },
  { code: 'sw', nativeName: 'Kiswahili', promptName: 'Swahili' },
  { code: 'ta', nativeName: 'தமிழ்', promptName: 'Tamil' },
  { code: 'te', nativeName: 'తెలుగు', promptName: 'Telugu' },
  { code: 'mr', nativeName: 'मराठी', promptName: 'Marathi' },
  { code: 'gu', nativeName: 'ગુજરાતી', promptName: 'Gujarati' },
  { code: 'kn', nativeName: 'ಕನ್ನಡ', promptName: 'Kannada' },
  { code: 'ml', nativeName: 'മലയാളം', promptName: 'Malayalam' },
  { code: 'pa', nativeName: 'ਪੰਜਾਬੀ', promptName: 'Punjabi' },
  { code: 'ne', nativeName: 'नेपाली', promptName: 'Nepali' },
  { code: 'si', nativeName: 'සිංහල', promptName: 'Sinhala' },
  { code: 'my', nativeName: 'မြန်မာ', promptName: 'Burmese' },
] as const;

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]['code'];

export const LIN_TRANSLATION_LANGUAGE_CHANGED_CHANNEL = 'lin:translation-language-changed';

const TRANSLATION_LANGUAGE_BY_CODE = new Map<TranslationLanguage, (typeof TRANSLATION_LANGUAGES)[number]>(
  TRANSLATION_LANGUAGES.map((language) => [language.code, language]),
);

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && TRANSLATION_LANGUAGE_BY_CODE.has(value as TranslationLanguage);
}

export function translationLanguagePromptName(language: TranslationLanguage): string {
  return TRANSLATION_LANGUAGE_BY_CODE.get(language)?.promptName ?? language;
}

export function languageTagMatchesTranslationLanguage(
  declaredLanguage: string | null | undefined,
  targetLanguage: TranslationLanguage,
): boolean {
  const tag = declaredLanguage?.trim().replaceAll('_', '-').toLowerCase() ?? '';
  if (!tag) return false;

  if (targetLanguage === 'zh-Hans') {
    return tag === 'zh'
      || tag.startsWith('zh-hans')
      || tag.startsWith('zh-cn')
      || tag.startsWith('zh-sg');
  }
  if (targetLanguage === 'zh-Hant') {
    return tag.startsWith('zh-hant')
      || tag.startsWith('zh-tw')
      || tag.startsWith('zh-hk')
      || tag.startsWith('zh-mo');
  }

  const primary = tag.split('-')[0];
  if (targetLanguage === 'nb') return primary === 'nb' || primary === 'no';
  if (targetLanguage === 'fil') return primary === 'fil' || primary === 'tl';
  if (targetLanguage === 'he') return primary === 'he' || primary === 'iw';
  if (targetLanguage === 'id') return primary === 'id' || primary === 'in';
  return primary === targetLanguage.toLowerCase();
}
