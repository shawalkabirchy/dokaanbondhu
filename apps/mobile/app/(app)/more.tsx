import type { ShopSettingsView } from "@dokaanbondhu/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch, Text, View } from "react-native";
import { api } from "../../src/lib/api";
import { fetchHealth } from "../../src/lib/health";
import { checkServerAddress } from "../../src/lib/server-address";
import { useMe } from "../../src/lib/session";
import { useDeviceSettings, type Language } from "../../src/lib/settings-store";
import { supabase } from "../../src/lib/supabase";
import { Button, Chips, colors, Field, Heading, Note, Screen, styles } from "../../src/ui";

// The Indic Parler-TTS speakers recommended for Bangla; the shop's default is "aditi" (spec 7.2).
const VOICES = [
  { value: "aditi", label: "Aditi" },
  { value: "arjun", label: "Arjun" },
];

/** Settings (spec 15.2): language, the owner's switches, the server address (advanced), sign out. */
export default function More() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useMe();
  const { language, setLanguage, serverUrl, setServerUrl } = useDeviceSettings();
  const [address, setAddress] = useState(serverUrl);
  const [addressNote, setAddressNote] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);
  const owner = me.data?.user.role === "owner";
  const settings = me.data?.settings;

  const save = useMutation({
    mutationFn: (patch: Partial<ShopSettingsView>) => api("/settings", { method: "PATCH", body: patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  async function checkAddress() {
    const check = checkServerAddress(address, __DEV__);
    if (!check.ok) {
      setAddressNote({
        text: t(check.reason === "https_only" ? "settings.server_https" : "settings.server_bad"),
        tone: "danger",
      });
      return;
    }
    try {
      const health = await fetchHealth(check.url);
      if (health.status !== "ok") throw new Error("down");
      setServerUrl(check.url);
      setAddress(check.url);
      setAddressNote({ text: t("settings.server_ok"), tone: "ok" });
      await queryClient.invalidateQueries();
    } catch {
      setAddressNote({ text: t("settings.server_bad"), tone: "danger" });
    }
  }

  return (
    <Screen>
      {me.data ? (
        <View style={styles.card}>
          <Note>{t("settings.shop")}</Note>
          <Text style={{ fontSize: 20, fontWeight: "700", color: colors.ink }}>{me.data.shop.name}</Text>
          <Note>
            {t("settings.signed_in_as")}: {me.data.user.name} (
            {t(owner ? "settings.role_owner" : "settings.role_staff")})
          </Note>
        </View>
      ) : null}

      <Heading>{t("settings.language")}</Heading>
      <Chips<Language>
        value={language}
        options={[
          { value: "bn", label: "বাংলা" },
          { value: "en", label: "English" },
        ]}
        onChange={setLanguage}
      />

      {owner && settings ? (
        <>
          <Heading>{t("settings.voice")}</Heading>
          <Chips value={settings.voice} options={VOICES} onChange={(voice) => save.mutate({ voice })} />
          <View style={styles.row}>
            <Text style={{ fontSize: 17, flex: 1, color: colors.ink }}>{t("settings.external")}</Text>
            <Switch
              value={settings.external_providers_allowed}
              onValueChange={(value) => save.mutate({ external_providers_allowed: value })}
            />
          </View>
          <View style={styles.row}>
            <Text style={{ fontSize: 17, flex: 1, color: colors.ink }}>{t("settings.staff_price")}</Text>
            <Switch
              value={settings.staff_price_override}
              onValueChange={(value) => save.mutate({ staff_price_override: value })}
            />
          </View>
          {save.isSuccess ? <Note tone="ok">{t("settings.saved")}</Note> : null}
          {save.isError ? <Note tone="danger">{t("common.error")}</Note> : null}
        </>
      ) : null}

      <Heading>{t("settings.advanced")}</Heading>
      <Field
        label={t("settings.server")}
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        keyboardType="url"
      />
      {addressNote ? <Note tone={addressNote.tone}>{addressNote.text}</Note> : null}
      <Button label={t("settings.server_check")} kind="plain" onPress={checkAddress} />

      <Button
        label={t("settings.sign_out")}
        kind="plain"
        onPress={async () => {
          await supabase.auth.signOut();
          queryClient.clear();
          router.replace("/login");
        }}
      />
    </Screen>
  );
}
