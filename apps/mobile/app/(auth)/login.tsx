import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../../src/lib/supabase";
import { Button, colors, Field, Note, styles } from "../../src/ui";

/** Email and password (Supabase Auth); public sign-up is off, so every login is made by the admin or the owner. */
export default function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setBusy(true);
    setFailed(false);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setFailed(true);
    else router.replace("/voice");
  }

  return (
    <SafeAreaView style={styles.flex}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "center" }}>
        <View style={styles.screen}>
          <Text style={{ fontSize: 32, fontWeight: "800", color: colors.green }}>{t("login.title")}</Text>
          <Note>{t("login.subtitle")}</Note>
          <Field
            label={t("login.email")}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
          />
          <Field label={t("login.password")} value={password} onChangeText={setPassword} secureTextEntry />
          {failed ? <Note tone="danger">{t("login.failed")}</Note> : null}
          <Button label={t("login.submit")} onPress={signIn} disabled={busy || !email || !password} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
