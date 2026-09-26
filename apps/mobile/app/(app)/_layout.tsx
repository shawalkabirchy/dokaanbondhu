import { Redirect, Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { useMe, useSession } from "../../src/lib/session";
import { colors } from "../../src/ui";

/** The signed-in app: voice (default), chat, history, staff (owner only) and more (spec 15.2). */
export default function AppLayout() {
  const { t } = useTranslation();
  const { session, loading } = useSession();
  const me = useMe(!!session);
  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  if (!session) return <Redirect href="/login" />;
  const owner = me.data?.user.role === "owner";
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.green,
        tabBarLabelStyle: { fontSize: 14 },
        headerTitleStyle: { fontSize: 20 },
      }}
    >
      <Tabs.Screen name="voice" options={{ title: t("tabs.voice") }} />
      <Tabs.Screen name="chat" options={{ title: t("tabs.chat") }} />
      <Tabs.Screen name="history" options={{ title: t("tabs.history") }} />
      <Tabs.Screen name="staff" options={{ title: t("tabs.staff"), href: owner ? undefined : null }} />
      <Tabs.Screen name="more" options={{ title: t("tabs.more") }} />
    </Tabs>
  );
}
