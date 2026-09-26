import { messages } from "@dokaanbondhu/i18n";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { useDeviceSettings } from "./settings-store";

// Every visible string comes from a key in packages/i18n; Bangla is the default, the choice is kept on the device
// (spec 15.6). Replies from the server are always Bangla.

void i18next.use(initReactI18next).init({
  resources: { bn: { translation: messages.bn }, en: { translation: messages.en } },
  lng: useDeviceSettings.getState().language,
  fallbackLng: "bn",
  interpolation: { escapeValue: false },
});

useDeviceSettings.subscribe((state) => {
  if (i18next.language !== state.language) void i18next.changeLanguage(state.language);
});

export default i18next;
