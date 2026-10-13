import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDeviceSettings, type Language } from "../../src/lib/settings-store";
import { supabase } from "../../src/lib/supabase";
import { colors, space } from "../../src/theme";
import { Button, Field, IconButton, Note, Segmented } from "../../src/ui";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const LOGO = require("../../assets/images/splash-icon.png") as number;

/**
 * Email and password (Supabase Auth); public sign-up is off, so every login is made by the admin or the owner. The
 * language can be chosen before signing in, and the password shown while typing it (D166).
 */
export default function Login() {
  const { t } = useTranslation();
  const { language, setLanguage } = useDeviceSettings();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setBusy(true);
    setFailed(false);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setFailed(true);
    else router.replace("/assistant");
  }

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.top}>
        <Segmented<Language>
          value={language}
          options={[
            { value: "bn", label: "বাংলা" },
            { value: "en", label: "English" },
          ]}
          onChange={setLanguage}
        />
      </View>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Image source={LOGO} style={styles.logo} accessibilityIgnoresInvertColors />
            <Text style={styles.title}>{t("login.title")}</Text>
            <Text style={styles.subtitle}>{t("login.subtitle")}</Text>
          </View>
          <Field
            label={t("login.email")}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
          />
          <Field
            label={t("login.password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!shown}
            autoCapitalize="none"
            right={
              <IconButton
                icon={shown ? "eye-off-outline" : "eye-outline"}
                label={t(shown ? "login.hide_password" : "login.show_password")}
                color={colors.muted}
                onPress={() => setShown(!shown)}
              />
            }
          />
          {failed ? <Note tone="danger">{t("login.failed")}</Note> : null}
          <Button label={t("login.submit")} onPress={signIn} loading={busy} disabled={!email || !password} />
          <Text style={styles.note}>{t("login.note")}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.card },
  flex: { flex: 1 },
  top: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  body: {
    flexGrow: 1,
    justifyContent: "center",
    gap: space.lg,
    paddingHorizontal: space.xxl,
    paddingBottom: 40,
  },
  brand: { alignItems: "center", gap: space.sm, marginBottom: space.sm },
  logo: { width: 88, height: 88 },
  title: { fontSize: 30, fontWeight: "700", color: colors.greenInk, marginTop: space.xs },
  subtitle: { fontSize: 16, color: colors.muted, textAlign: "center" },
  note: { fontSize: 14, color: colors.muted, textAlign: "center" },
});
