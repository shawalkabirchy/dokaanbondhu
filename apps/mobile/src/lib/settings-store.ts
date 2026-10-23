import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// What the device remembers (spec 15.5, 15.6, 15.9): the language (Bangla by default), the server address, and
// whether the floating mic is wanted (off by default).

export type Language = "bn" | "en";

interface DeviceSettings {
  language: Language;
  serverUrl: string;
  floatingMic: boolean;
  setLanguage: (language: Language) => void;
  setServerUrl: (url: string) => void;
  setFloatingMic: (on: boolean) => void;
}

export const useDeviceSettings = create<DeviceSettings>()(
  persist(
    (set) => ({
      language: "bn",
      serverUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3100",
      floatingMic: false,
      setLanguage: (language) => set({ language }),
      setServerUrl: (serverUrl) => set({ serverUrl }),
      setFloatingMic: (floatingMic) => set({ floatingMic }),
    }),
    { name: "device-settings", storage: createJSONStorage(() => AsyncStorage) },
  ),
);
