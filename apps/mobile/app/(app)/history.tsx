import type { ActionsPage, ActionView } from "@dokaanbondhu/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { api, ApiError } from "../../src/lib/api";
import { useChat } from "../../src/lib/chat";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { streamTurn } from "../../src/lib/stream";
import { Button, colors, Heading, Note, Screen, styles } from "../../src/ui";

/**
 * The history (spec 15.2): actions newest first (staff see their own, the owner sees all), each with what its
 * confirmation said, its status and who did it, and Undo where the caller may undo it now (spec 11.9.1, D38: staff
 * only their own, from the conversation it was made in, within 10 minutes). The undo's reply is shown here.
 */
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

  const actions = history.data?.pages.flatMap((page) => page.actions) ?? [];
  const when = (iso: string) =>
    new Date(iso).toLocaleString(language === "bn" ? "bn-BD" : "en-GB", {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <Screen>
      <Heading>{t("history.title")}</Heading>
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
      {history.isLoading ? <Note>{t("common.loading")}</Note> : null}
      {history.isError ? <Note tone="danger">{errorText(history.error)}</Note> : null}
      {!history.isLoading && actions.length === 0 ? <Note>{t("history.empty")}</Note> : null}
      {actions.map((action) => (
        <View key={action.id} style={[styles.card, { gap: 6 }]}>
          <Text style={{ fontSize: 17, color: colors.ink }}>
            {action.undo_of ? t("history.undo_of") : action.text}
          </Text>
          <Note
            tone={
              action.status === "done" || action.status === "undone"
                ? "ok"
                : action.status === "pending"
                  ? "muted"
                  : "danger"
            }
          >
            {t(`history.status_${action.status}`)}
            {action.verify_status === "mismatch" ? ` · ${t("history.check_mismatch")}` : ""}
          </Note>
          <Note>
            {action.user_name} · {when(action.created_at)}
          </Note>
          {action.undo_available ? (
            <Button
              kind="plain"
              label={undoing === action.id ? t("common.loading") : t("history.undo")}
              disabled={undoing !== null}
              onPress={() => void undo(action)}
            />
          ) : null}
        </View>
      ))}
      {history.hasNextPage ? (
        <Button
          kind="plain"
          label={t("history.more")}
          disabled={history.isFetchingNextPage}
          onPress={() => void history.fetchNextPage()}
        />
      ) : null}
    </Screen>
  );
}
