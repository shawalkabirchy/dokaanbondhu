// Builds the demo APK as a file (spec 15.1, D116, D117): the app with its JavaScript inside, pointed at the server's
// hosted copy by .env.demo. No phone or cable is needed: the file is sent to the phone and installed there.
// Run from apps/mobile: npm run build:demo -w apps/mobile
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

// Which key signed it (D249): with the owner's upload key the file is also copied as DokaanBondhu-AI.apk, the name
// the landing page downloads; with the debug key it is only for our own phones.
const signer = signerOf(apk);
if (signer === undefined) {
  process.stdout.write("could not check the signature (apksigner not found under ANDROID_HOME)\n");
} else if (/CN=Android Debug/.test(signer)) {
  process.stdout.write(
    "signed with the DEBUG key: not for the landing page (see run-commands.md section 13)\n",
  );
} else {
  const publicApk = resolve("dist", "DokaanBondhu-AI.apk");
  copyFileSync(apk, publicApk);
  process.stdout.write(`signed with your own key:\n${signer}\npublic APK: ${publicApk}\n`);
}

/** apksigner's lines naming the signer and its SHA-256, or undefined without the build tools. */
function signerOf(file) {
  const tools = join(process.env.ANDROID_HOME ?? "", "build-tools");
  if (!existsSync(tools)) return undefined;
  const newest = readdirSync(tools)
    .filter((name) => /^\d+(\.\d+)*$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (newest === undefined) return undefined;
  const tool = join(tools, newest, process.platform === "win32" ? "apksigner.bat" : "apksigner");
  if (!existsSync(tool)) return undefined;
  const check =
    process.platform === "win32"
      ? spawnSync(`"${tool}" verify --print-certs "${file}"`, { shell: true, encoding: "utf8" })
      : spawnSync(tool, ["verify", "--print-certs", file], { encoding: "utf8" });
  if (check.status !== 0) return undefined;
  return check.stdout
    .split("\n")
    .filter((line) => /certificate (DN|SHA-256 digest)/.test(line))
    .join("\n");
}
