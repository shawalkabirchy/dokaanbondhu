import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// What the device remembers (spec 15.5, 15.6): the language (Bangla by default) and the server address.

export type Language = "bn" | "en";

interface DeviceSettings {
  language: Language;
  serverUrl: string;
  setLanguage: (language: Language) => void;
  setServerUrl: (url: string) => void;
}

export const useDeviceSettings = create<DeviceSettings>()(
  persist(
    (set) => ({
      language: "bn",
      serverUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3100",
      setLanguage: (language) => set({ language }),
      setServerUrl: (serverUrl) => set({ serverUrl }),
    }),
    { name: "device-settings", storage: createJSONStorage(() => AsyncStorage) },
  ),
);
