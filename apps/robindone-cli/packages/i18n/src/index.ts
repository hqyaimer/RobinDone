import type { UiLocale, SupportedLocale } from "@robindone/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { RobinDoneCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, RobinDoneCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, RobinDoneCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function getRobinDoneCopy(locale?: UiLocale | string, detected?: string | null): RobinDoneCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
