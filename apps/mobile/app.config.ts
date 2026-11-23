import type { ExpoConfig } from "expo/config";

// The app configuration (spec 15.1). Development builds may call http://localhost (the laptop server through
// adb reverse), so they allow plain HTTP: the template's debug manifests switch it on for them alone. Every release
// build (the public APK, D249) accepts only https addresses.
const config: ExpoConfig = {
  name: "DokaanBondhu",
  slug: "dokaanbondhu",
  scheme: "dokaanbondhu",
  version: "0.1.0",
  orientation: "portrait",
  // The app icon (D166): made from assets/images/icon.svg by `npm run icons`.
  icon: "./assets/images/icon.png",
  android: {
    package: "com.dokaanbondhu.app", // D30
    // Raised with `version` for every new public APK (D249), so Android installs it over the old one.
    versionCode: 1,
    adaptiveIcon: { foregroundImage: "./assets/images/adaptive-icon.png", backgroundColor: "#1f7a4d" },
    permissions: ["android.permission.RECORD_AUDIO"],
    // The app template's storage permissions are not needed: audio files stay in the app's own cache (D81). Drawing
    // over other apps and the microphone service come from the floating mic's module (modules/floating-mic, spec 15.9).
    blockedPermissions: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // Push-to-talk records only while a button is held, so the library's phone-call, Bluetooth, notification and
    // background-recording permissions stay off (D81); the floating mic's own service covers recording with another
    // app in front (spec 15.9).
    [
      "@siteed/audio-studio",
      {
        enablePhoneStateHandling: false,
        enableNotifications: false,
        enableBackgroundAudio: false,
        enableDeviceDetection: false,
      },
    ],
    ["expo-build-properties", { android: { usesCleartextTraffic: false } }],
    // The owner's own upload key for the release build (spec 15.1, D249).
    "./plugins/with-release-signing",
    [
      "expo-splash-screen",
      { image: "./assets/images/splash-icon.png", imageWidth: 120, backgroundColor: "#ffffff" },
    ],
  ],
  experiments: { typedRoutes: false },
};

export default config;
