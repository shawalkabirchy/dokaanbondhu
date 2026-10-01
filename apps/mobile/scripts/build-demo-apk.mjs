// Builds the demo APK as a file (spec 15.1, D116, D117): the app with its JavaScript inside, pointed at the server's
// hosted copy by .env.demo. No phone or cable is needed: the file is sent to the phone and installed there.
// Run from apps/mobile: npm run build:demo -w apps/mobile
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// Values already in the environment win over .env files, and a release bundle never reads .env.development.
process.loadEnvFile(".env.demo");

if (!existsSync("android")) {
  process.stderr.write("android/ is missing: run npx expo prebuild -p android first\n");
  process.exit(1);
}

// 64-bit and older 32-bit phones; x86 is only for emulators.
const args = ["assembleRelease", "-PreactNativeArchitectures=arm64-v8a,armeabi-v7a", "--no-daemon"];
const options = { cwd: "android", stdio: "inherit" };
// Windows runs a .bat only through cmd, given one command string (the arguments are fixed); the path is explicit
// because cmd may not search the current folder.
const build =
  process.platform === "win32"
    ? spawnSync([".\\gradlew.bat", ...args].join(" "), { ...options, shell: true })
    : spawnSync("./gradlew", args, options);
if (build.status !== 0) process.exit(build.status ?? 1);

const apk = resolve("dist", "DokaanBondhu-demo.apk");
mkdirSync("dist", { recursive: true });
copyFileSync("android/app/build/outputs/apk/release/app-release.apk", apk);
process.stdout.write(`demo APK: ${apk}\n`);
