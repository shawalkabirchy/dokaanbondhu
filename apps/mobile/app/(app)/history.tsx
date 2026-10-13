import type { ActionsPage, ActionView } from "@dokaanbondhu/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { api, ApiError } from "../../src/lib/api";
import { useChat } from "../../src/lib/chat";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { streamTurn } from "../../src/lib/stream";
import { colors, space, type } from "../../src/theme";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  GroupLabel,
  Icon,
  Note,
  Screen,
  type IconName,
  type Tone,
} from "../../src/ui";

/**
 * The history (spec 15.2, D166): actions newest first (staff see their own, the owner sees all), grouped by day, each
 * with what its confirmation said, its status and who did it, and Undo where the caller may undo it now (spec 11.9.1,
 * D38: staff only their own, from the conversation it was made in, within 10 minutes). The undo's reply is shown here.
 * Pulled down, the list is read again.
 */

const STATUS_LOOK: Record<ActionView["status"], { tone: Tone; icon: IconName }> = {
  done: { tone: "green", icon: "check-bold" },
  undone: { tone: "grey", icon: "undo-variant" },
  pending: { tone: "blue", icon: "timer-sand" },
  failed: { tone: "red", icon: "alert-circle-outline" },
  review: { tone: "amber", icon: "alert-outline" },
  cancelled: { tone: "grey", icon: "close" },
};

const ICON_COLORS: Record<Tone, { bg: string; ink: string }> = {
  green: { bg: colors.greenSoft, ink: colors.greenInk },
  grey: { bg: colors.chip, ink: "#5d666e" },
  blue: { bg: colors.infoSoft, ink: colors.infoInk },
  red: { bg: colors.dangerSoft, ink: colors.danger },
  amber: { bg: colors.warnSoft, ink: colors.warnInk },
};

export default function History() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const conversationId = useChat((state) => state.conversationId);
  const queryClient = useQueryClient();
  const [undoing, setUndoing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["actions", conversationId],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (pageParam) query.set("cursor", pageParam);
      if (conversationId) query.set("conversation_id", conversationId);
      return api<ActionsPage>(`/actions?${query}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });

  const errorText = (error: unknown) =>
    error instanceof ApiError && error.body
      ? language === "bn"
        ? error.body.message_bn
        : error.body.message_en
      : t("common.error");

  const undo = async (action: ActionView) => {
    setUndoing(action.id);
    setMessage(null);
    const texts: string[] = [];
    let done = false;
    try {
      await streamTurn(
        `/actions/${action.id}/undo`,
        conversationId ? { conversation_id: conversationId } : {},
        (event) => {
          if (event.type === "text") texts[event.seq] = event.text;
          if (event.type === "action_result") done = event.status === "done";
        },
      );
      setMessage({ text: texts.filter(Boolean).join(" "), tone: done ? "ok" : "danger" });
    } catch (error) {
      setMessage({ text: errorText(error), tone: "danger" });
    } finally {
      setUndoing(null);
      await queryClient.invalidateQueries({ queryKey: ["actions"] });
    }
  };

  const locale = language === "bn" ? "bn-BD" : "en-GB";
  const actions = history.data?.pages.flatMap((page) => page.actions) ?? [];
  const dayOf = (iso: string) => new Date(iso).toDateString();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  const dayLabel = (iso: string) => {
    const day = dayOf(iso);
    if (day === today) return t("history.today");
    if (day === yesterday) return t("history.yesterday");
    return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "long" });
  };
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const days: { label: string; actions: ActionView[] }[] = [];
  for (const action of actions) {
    const label = dayLabel(action.created_at);
    const last = days.at(-1);
    if (last?.label === label) last.actions.push(action);
    else days.push({ label, actions: [action] });
  }

  return (
    <Screen
      title={t("history.title")}
      refreshing={history.isRefetching && !history.isFetchingNextPage}
      onRefresh={() => void history.refetch()}
    >
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
      {history.isLoading ? <ActivityIndicator color={colors.green} style={styles.loading} /> : null}
      {history.isError ? <Note tone="danger">{errorText(history.error)}</Note> : null}
      {!history.isLoading && actions.length === 0 ? (
        <EmptyState icon="history" text={t("history.empty")} />
      ) : null}
      {days.map((day) => (
        <View key={day.label} style={styles.day}>
          <GroupLabel>{day.label}</GroupLabel>
          <Card rows>
            {day.actions.map((action) => {
              const look = STATUS_LOOK[action.status];
              const icon = ICON_COLORS[look.tone];
              return (
                <View key={action.id} style={styles.item}>
                  <View style={[styles.icon, { backgroundColor: icon.bg }]}>
                    <Icon name={look.icon} color={icon.ink} />
                  </View>
                  <View style={styles.body}>
                    <Text style={styles.text}>{action.undo_of ? t("history.undo_of") : action.text}</Text>
                    <Text style={styles.meta}>
                      {action.user_name} · {time(action.created_at)}
                    </Text>
                    <View style={styles.footer}>
                      <View style={styles.badges}>
                        <Badge label={t(`history.status_${action.status}`)} tone={look.tone} />
                        {action.verify_status === "mismatch" ? (
                          <Badge label={t("history.check_mismatch")} tone="amber" icon="alert-outline" />
                        ) : null}
                      </View>
                      {action.undo_available ? (
                        <Button
                          small
                          kind="plain"
                          icon="undo-variant"
                          label={t("history.undo")}
                          loading={undoing === action.id}
                          disabled={undoing !== null}
                          onPress={() => void undo(action)}
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              );
            })}
          </Card>
        </View>
      ))}
      {history.hasNextPage ? (
        <Button
          kind="plain"
          label={t("history.more")}
          loading={history.isFetchingNextPage}
          onPress={() => void history.fetchNextPage()}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: space.xl },
  day: { gap: space.md },
  item: { flexDirection: "row", gap: space.md, padding: 14 },
  icon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, gap: 6 },
  text: { fontSize: type.body - 1, fontWeight: "600", color: colors.ink },
  meta: { fontSize: 14, color: colors.muted },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    flexWrap: "wrap",
  },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
