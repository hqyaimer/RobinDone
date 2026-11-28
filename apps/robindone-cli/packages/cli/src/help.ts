import { getRobinDoneCopy, type SupportedLocale, type UiLocale } from "@robindone/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getRobinDoneCopy(locale, detectedLocale).cli.help(version);
}
