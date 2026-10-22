import type { Reminders } from "@dokaanbondhu/contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { api } from "./lib/api";
import { numberText, takaText } from "./lib/money";
import { useDeviceSettings } from "./lib/settings-store";
import { colors, space } from "./theme";
import { Card, ListRow } from "./ui";

// The reminders card at the top of the assistant page (spec 15.2, D194): parts running low and customers' old dues,
// counted, with the first few names. It shows only when there is something to remind; a tap asks the assistant, so
// the list comes as an answer in the conversation. Nothing is spoken or sent as a notification. When the server or
// the shop's app cannot answer, the card is simply not there.

/** How long the counts are kept before the card asks again. */
const FRESH_MS = 60_000;

export function RemindersCard(props: { onAsk: (question: string) => void }) {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const reminders = useQuery({
    queryKey: ["reminders"],
    queryFn: () => api<Reminders>("/reminders"),
    staleTime: FRESH_MS,
    retry: false,
  });
  const low = reminders.data?.low_stock;
  const old = reminders.data?.old_dues;
  if (!low?.count && !old?.count) return null;
  const count = (value: { count: number; more: boolean }) =>
    `${numberText(value.count, language)}${value.more ? "+" : ""}`;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{t("reminders.title")}</Text>
      <Card rows>
        {low?.count ? (
          <ListRow
            icon="package-variant"
            tone="amber"
            title={t("reminders.low", { count: count(low) })}
            subtitle={low.names.join(", ")}
            chevron
            onPress={() => props.onAsk(t("reminders.low_ask"))}
          />
        ) : null}
        {old?.count ? (
          <ListRow
            icon="account-clock-outline"
            tone="amber"
            title={t("reminders.old", { count: count(old), taka: takaText(old.old_taka, language) })}
            subtitle={old.names.join(", ")}
            chevron
            onPress={() => props.onAsk(t("reminders.old_ask"))}
          />
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.xs },
  title: { fontSize: 14, fontWeight: "700", color: colors.muted, marginLeft: space.xs },
});
