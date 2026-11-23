// The release signing written into android/app/build.gradle (spec 15.1, D249).
const { addReleaseSigning } = require("./with-release-signing");

// The part of Expo's template the plugin changes, as `expo prebuild` writes it.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe("addReleaseSigning", () => {
  it("adds a release signing that reads the owner's key from the Gradle properties", () => {
    const text = addReleaseSigning(TEMPLATE);
    expect(text).toContain("storeFile file(findProperty('DOKAAN_UPLOAD_STORE_FILE'))");
    expect(text).toContain("storePassword findProperty('DOKAAN_UPLOAD_STORE_PASSWORD')");
    expect(text).toContain("keyAlias findProperty('DOKAAN_UPLOAD_KEY_ALIAS')");
    expect(text).toContain("keyPassword findProperty('DOKAAN_UPLOAD_KEY_PASSWORD')");
  });

  it("signs the release build with that key when it is set, else with the debug key", () => {
    const text = addReleaseSigning(TEMPLATE);
    const release = text.slice(text.indexOf("buildTypes {"));
    expect(release).toContain(
      "signingConfig findProperty('DOKAAN_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
    );
    // The debug build keeps the debug key.
    expect(release.slice(0, release.indexOf("release {"))).toContain("signingConfig signingConfigs.debug");
  });

  it("changes nothing the second time", () => {
    const once = addReleaseSigning(TEMPLATE);
    expect(addReleaseSigning(once)).toBe(once);
  });

  it("stops the build when Expo's template no longer looks as expected", () => {
    expect(() => addReleaseSigning("android {\n}\n")).toThrow(/signingConfigs/);
    const noRelease = TEMPLATE.replace(/ {8}release \{[\s\S]*?\n {8}\}\n/, "");
    expect(() => addReleaseSigning(noRelease)).toThrow(/release build type/);
  });
});
