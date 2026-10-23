import { Redirect, Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View, type ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloatingMicBridge } from "../../src/floating-mic-bridge";
import { useSpeechWake } from "../../src/lib/health";
import { useMe, useSession } from "../../src/lib/session";
import { VoiceProvider } from "../../src/lib/voice";
import { colors } from "../../src/theme";
import { Icon, type IconName } from "../../src/ui";

/** A tab's icon: a soft green pill behind the chosen one (D166). */
function tabIcon(name: IconName) {
  function TabIcon({ focused, color }: { focused: boolean; color: ColorValue }) {
    return (
      <View style={[styles.pill, focused && styles.pillOn]}>
        <Icon name={name} color={color} />
      </View>
    );
  }
  return TabIcon;
}

/**
 * The signed-in app (spec 15.2, D166): the assistant (default), history, staff (owner only) and more; each page draws
 * its own top bar. Around them the app's one voice, shared by the assistant page and the floating mic (spec 15.9).
 */
export default function AppLayout() {
  const { t } = useTranslation();
  const { session, loading } = useSession();
  const me = useMe(!!session);
  // The bar's own height plus the phone's gesture or button bar under it, so the labels are not squeezed.
  const bottom = useSafeAreaInsets().bottom;
  useSpeechWake(!!session); // the speech worker starts waking as soon as the app opens (D164)
  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }
  if (!session) return <Redirect href="/login" />;
  const owner = me.data?.user.role === "owner";
  return (
    <VoiceProvider>
      <FloatingMicBridge />
      <Tabs
        // Back returns to the page before (setup goes back to More), not to the first tab.
        backBehavior="history"
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.greenInk,
          tabBarInactiveTintColor: colors.muted,
          tabBarLabelStyle: styles.label,
          tabBarStyle: [styles.bar, { height: 66 + bottom }],
        }}
      >
        <Tabs.Screen
          name="assistant"
          options={{ title: t("tabs.assistant"), tabBarIcon: tabIcon("microphone-outline") }}
        />
        <Tabs.Screen name="history" options={{ title: t("tabs.history"), tabBarIcon: tabIcon("history") }} />
        <Tabs.Screen
          name="staff"
          options={{
            title: t("tabs.staff"),
            tabBarIcon: tabIcon("account-group-outline"),
            href: owner ? undefined : null,
          }}
        />
        <Tabs.Screen name="more" options={{ title: t("tabs.more"), tabBarIcon: tabIcon("menu") }} />
        {/* Setup is opened from More (owner only), not from the tab bar. */}
        <Tabs.Screen name="setup/index" options={{ title: t("setup.title"), href: null }} />
      </Tabs>
    </VoiceProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.page },
  bar: { paddingTop: 6, backgroundColor: colors.card, borderTopColor: colors.line },
  label: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  pill: { width: 60, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  pillOn: { backgroundColor: colors.greenSoft },
});
