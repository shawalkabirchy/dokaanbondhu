import type { ReplyEvent } from "@dokaanbondhu/contracts";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { AssistantBubble, MemoryLine, UserBubble } from "../../src/chat-ui";
import { phonePlayer } from "../../src/lib/audio";
import { useChat } from "../../src/lib/chat";
import { ReplyPlayer } from "../../src/lib/reply-player";
import { useMe } from "../../src/lib/session";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { Button, colors, OfflineBanner } from "../../src/ui";

/**
 * The chat page (spec 15.2): the message list with cards, tables and chips, what is remembered, and the input at the
 * bottom. The list is the voice page's too: one conversation for both (D125). The speaker switch asks for the spoken
 * reply too (speak: true, D88), played in sentence order; it is hidden when the developer has switched reading aloud
 * off (AI_SPEAK=off, D114).
 */
export default function Chat() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const { messages, busy, send, reset, remembered, forget } = useChat();
  const [text, setText] = useState("");
  const [speak, setSpeak] = useState(false);
  const speaks = useMe().data?.providers.speaks ?? true;
  const player = useRef<ReplyPlayer | null>(null);
  const [top, setTop] = useState(0);
  const box = useRef<View>(null);
  const list = useRef<ScrollView>(null);
  const newestReply = [...messages].reverse().find((message) => message.kind === "assistant");

  useEffect(() => () => player.current?.stop(), []);

  /** Sending options: with the speaker on, the reply's audio is played by a new player. */
  const options = () => {
    player.current?.stop();
    if (!speak || !speaks) return {};
    const current = new ReplyPlayer(phonePlayer, Crypto.randomUUID());
    player.current = current;
    const tap = (event: ReplyEvent) => {
      if (event.type === "audio") current.add(event.seq, event.data);
      if (event.type === "done") current.end();
    };
    return { speak: true, tap };
  };

  const submit = () => {
    const question = text.trim();
    if (!question || busy) return;
    setText("");
    void send({ text: question }, options());
  };

  return (
    // The page makes room for the keyboard itself, as every page does (D82).
    <View ref={box} style={styles.flex} onLayout={() => box.current?.measureInWindow((_x, y) => setTop(y))}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={top}>
        <OfflineBanner />
        <ScrollView
          ref={list}
          style={styles.flex}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? <Text style={styles.hint}>{t("chat.empty")}</Text> : null}
          {messages.map((message) =>
            message.kind === "user" ? (
              // A voice question's words come with its transcript; until then there is no bubble.
              message.text ? (
                <UserBubble key={message.id} text={message.text} />
              ) : null
            ) : (
              <AssistantBubble
                key={message.id}
                message={message}
                language={language}
                newest={message.id === newestReply?.id}
                busy={busy}
                onChoose={(slot, option) =>
                  void send({ choice: { slot, option_id: option.id }, label: option.label }, options())
                }
              />
            ),
          )}
        </ScrollView>
        <MemoryLine remembered={remembered} onForget={(key) => void forget(key)} />
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={t("chat.placeholder")}
            placeholderTextColor={colors.muted}
            multiline
            maxLength={500}
            onSubmitEditing={submit}
            accessibilityLabel={t("chat.placeholder")}
          />
          <Button label={t("chat.send")} onPress={submit} disabled={busy || !text.trim()} />
        </View>
        <View style={styles.newRow}>
          {speaks ? (
            <View style={styles.speakRow}>
              <Switch value={speak} onValueChange={setSpeak} accessibilityLabel={t("chat.speak")} />
              <Text style={styles.speakText}>{t("chat.speak")}</Text>
            </View>
          ) : (
            <View />
          )}
          {messages.length > 0 && !busy ? (
            <Button label={t("chat.new")} kind="plain" onPress={reset} />
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.white },
  list: { padding: 16, gap: 14 },
  hint: { fontSize: 17, color: colors.muted, lineHeight: 24 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderColor: colors.line,
  },
  input: {
    flex: 1,
    minHeight: 52,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    color: colors.ink,
  },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  speakRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  speakText: { fontSize: 16, color: colors.ink },
});
