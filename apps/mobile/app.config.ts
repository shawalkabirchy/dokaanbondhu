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
    // The app template's storage permissions are not needed: audio files stay in the app's own cache (D81).
    blockedPermissions: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      ...(release ? ["android.permission.SYSTEM_ALERT_WINDOW"] : []),
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // Push-to-talk records only while the button is held with the app open, so the library's phone-call, Bluetooth,
    // notification and background-recording permissions stay off (D81).
    [
      "@siteed/audio-studio",
      {
        enablePhoneStateHandling: false,
        enableNotifications: false,
        enableBackgroundAudio: false,
        enableDeviceDetection: false,
      },
    ],
    ["expo-build-properties", { android: { usesCleartextTraffic: !release } }],
  ],
  experiments: { typedRoutes: false },
};

export default config;
