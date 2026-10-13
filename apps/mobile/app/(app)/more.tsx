import type { ShopSettingsView } from "@dokaanbondhu/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Switch, Text, View } from "react-native";
import { api } from "../../src/lib/api";
import { fetchHealth } from "../../src/lib/health";
import { checkServerAddress } from "../../src/lib/server-address";
import { useMe } from "../../src/lib/session";
import { useDeviceSettings, type Language } from "../../src/lib/settings-store";
import { supabase } from "../../src/lib/supabase";
import { colors, space, type } from "../../src/theme";
import {
  Badge,
  Button,
  Card,
  confirmFirst,
  Field,
  GroupLabel,
  Icon,
  ListRow,
  Note,
  Screen,
  Segmented,
} from "../../src/ui";

// The Indic Parler-TTS speakers recommended for Bangla; the shop's default is "aditi" (spec 7.2).
const VOICES = [
  { value: "aditi", label: "Aditi" },
  { value: "arjun", label: "Arjun" },
];

/**
 * Settings (spec 15.2, D166), in groups: the shop and who is signed in; language; the owner's switches and setup; the
 * server address folded under Advanced (every phone sets its own, D31); sign out, asked first.
 */
export default function More() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useMe();
  const { language, setLanguage, serverUrl, setServerUrl } = useDeviceSettings();
  const [address, setAddress] = useState(serverUrl);
  const [advanced, setAdvanced] = useState(false);
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

  async function signOut() {
    const yes = await confirmFirst(
      t("settings.sign_out_ask"),
      t("settings.sign_out_ask_text"),
      t("settings.sign_out"),
      t("common.cancel"),
    );
    if (!yes) return;
    await supabase.auth.signOut();
    queryClient.clear();
    router.replace("/login");
  }

  return (
    <Screen title={t("settings.title")}>
      {me.data ? (
        <Card padded>
          <View style={styles.profile}>
            <View style={styles.avatar}>
              <Icon name="storefront-outline" size={26} color={colors.greenInk} />
            </View>
            <View style={styles.profileText}>
              <Text style={styles.shop}>{me.data.shop.name}</Text>
              <Text style={styles.signedIn}>
                {t("settings.signed_in_role", {
                  role: t(owner ? "settings.role_owner" : "settings.role_staff"),
                  name: me.data.user.name,
                })}
              </Text>
            </View>
            <Badge label={t(owner ? "settings.role_owner" : "settings.role_staff")} tone="green" />
          </View>
        </Card>
      ) : null}

      <GroupLabel>{t("settings.group_app")}</GroupLabel>
      <Card rows>
        <ListRow
          icon="translate"
          title={t("settings.language")}
          right={
            <Segmented<Language>
              value={language}
              options={[
                { value: "bn", label: "বাংলা" },
                { value: "en", label: "English" },
              ]}
              onChange={setLanguage}
            />
          }
        />
      </Card>

      {owner && settings ? (
        <>
          <GroupLabel>{t("settings.group_shop")}</GroupLabel>
          <Card rows>
            <ListRow
              icon="account-voice"
              title={t("settings.voice")}
              right={
                <Segmented
                  value={settings.voice}
                  options={VOICES}
                  onChange={(voice) => save.mutate({ voice })}
                />
              }
            />
            <ListRow
              icon="tag-outline"
              title={t("settings.staff_price")}
              subtitle={t("settings.staff_price_note")}
              right={
                <Switch
                  value={settings.staff_price_override}
                  onValueChange={(value) => save.mutate({ staff_price_override: value })}
                  trackColor={{ true: colors.green, false: "#c8cfd4" }}
                  thumbColor={colors.white}
                  accessibilityLabel={t("settings.staff_price")}
                />
              }
            />
            <ListRow
              icon="database-cog-outline"
              tone="green"
              title={t("setup.open")}
              subtitle={t("settings.setup_note")}
              chevron
              onPress={() => router.push("/setup")}
            />
          </Card>
          {save.isSuccess ? <Note tone="ok">{t("settings.saved")}</Note> : null}
          {save.isError ? <Note tone="danger">{t("common.error")}</Note> : null}
        </>
      ) : null}

      <GroupLabel>{t("settings.group_other")}</GroupLabel>
      <Card rows>
        <ListRow
          icon="tune-variant"
          title={t("settings.advanced")}
          subtitle={t("settings.advanced_note")}
          right={<Icon name={advanced ? "chevron-up" : "chevron-down"} color={colors.faint} />}
          onPress={() => setAdvanced(!advanced)}
        />
        {advanced ? (
          <View style={styles.advanced}>
            <Field
              label={t("settings.server")}
              value={address}
              onChangeText={setAddress}
              autoCapitalize="none"
              keyboardType="url"
            />
            {addressNote ? <Note tone={addressNote.tone}>{addressNote.text}</Note> : null}
            <Button
              label={t("settings.server_check")}
              kind="plain"
              icon="check-network-outline"
              onPress={checkAddress}
            />
          </View>
        ) : null}
        <ListRow
          icon="logout"
          tone="red"
          title={t("settings.sign_out")}
          danger
          onPress={() => void signOut()}
        />
      </Card>

      <Text style={styles.version}>
        {t("settings.version", { version: Constants.expoConfig?.version ?? "" })}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: "row", alignItems: "center", gap: space.md + 2 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.greenSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  profileText: { flex: 1, minWidth: 0 },
  shop: { fontSize: type.heading + 1, fontWeight: "700", color: colors.ink },
  signedIn: { fontSize: 14, color: colors.muted, marginTop: 2 },
  advanced: { padding: space.lg, gap: space.md },
  version: { fontSize: type.tiny, color: colors.muted, textAlign: "center", marginTop: space.sm },
});
