import type { ShopSettingsView } from "@dokaanbondhu/contracts";
import { AudioStudioModule } from "@siteed/audio-studio";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, StyleSheet, Switch, Text, View } from "react-native";
import { FloatingMic } from "../../modules/floating-mic";
import { api } from "../../src/lib/api";
import { useFloatingMicStatus } from "../../src/lib/floating-mic";
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
 * Settings (spec 15.2, D166), in groups: the shop and who is signed in; language and, on Android, the floating mic
 * (spec 15.9); the owner's switches and setup; the server address folded under Advanced (every phone sets its own,
 * D31); sign out, asked first.
 */
export default function More() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const me = useMe();
  const { language, setLanguage, serverUrl, setServerUrl, floatingMic, setFloatingMic } = useDeviceSettings();
  const floatingUp = useFloatingMicStatus((state) => state.running);
  const [micRefused, setMicRefused] = useState(false);
  // Read again on each return, for the way back from the phone's "display over other apps" page.
  const [, setReturns] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setReturns((n) => n + 1);
    });
    return () => subscription.remove();
  }, []);
  const overlayAllowed = FloatingMic?.canDrawOverlays() ?? false;
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

  /** On: the microphone first, then the phone's own page for drawing over other apps, explained before it opens. */
  async function switchFloatingMic(on: boolean) {
    setMicRefused(false);
    if (!on) {
      setFloatingMic(false);
      return;
    }
    if (!(await AudioStudioModule.requestPermissionsAsync())?.granted) {
      setMicRefused(true);
      return;
    }
    setFloatingMic(true);
    if (!FloatingMic?.canDrawOverlays()) await askOverlay();
  }

  async function askOverlay() {
    const go = await confirmFirst(
      t("floating.ask_title"),
      t("floating.ask_text"),
      t("floating.ask_go"),
      t("common.cancel"),
    );
    if (go) FloatingMic?.openOverlaySettings();
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
        {FloatingMic?.isSupported() ? (
          <ListRow
            icon="microphone-message"
            title={t("floating.title")}
            subtitle={t(floatingMic && floatingUp ? "floating.note_on" : "floating.note_off")}
            right={
              <Switch
                value={floatingMic}
                onValueChange={(on) => void switchFloatingMic(on)}
                trackColor={{ true: colors.green, false: "#c8cfd4" }}
                thumbColor={colors.white}
                accessibilityLabel={t("floating.title")}
              />
            }
          />
        ) : null}
      </Card>
      {floatingMic && FloatingMic && !overlayAllowed ? (
        <View style={styles.floatingAsk}>
          <Note tone="warn">{t("floating.need_overlay")}</Note>
          <Button label={t("floating.allow")} kind="plain" small onPress={() => void askOverlay()} />
        </View>
      ) : null}
      {micRefused ? <Note tone="danger">{t("floating.mic_needed")}</Note> : null}

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
  floatingAsk: { gap: space.sm, alignItems: "flex-start" },
  version: { fontSize: type.tiny, color: colors.muted, textAlign: "center", marginTop: space.sm },
});
