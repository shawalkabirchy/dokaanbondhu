import type { ExpoConfig } from "expo/config";

// The app configuration (spec 15.1). Development builds may call http://localhost (the laptop server through
// adb reverse), so they allow plain HTTP; the release build in step 9 accepts only https addresses.
const release = process.env.APP_VARIANT === "release";

const config: ExpoConfig = {
  name: "DokaanBondhu",
  slug: "dokaanbondhu",
  scheme: "dokaanbondhu",
  version: "0.1.0",
  orientation: "portrait",
  android: {
    package: "com.dokaanbondhu.app", // D30
    permissions: ["android.permission.RECORD_AUDIO"],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "@siteed/audio-studio",
    ["expo-build-properties", { android: { usesCleartextTraffic: !release } }],
  ],
  experiments: { typedRoutes: false },
};

export default config;
