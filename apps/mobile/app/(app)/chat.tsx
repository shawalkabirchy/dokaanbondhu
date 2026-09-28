import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AssistantBubble, UserBubble } from "../../src/chat-ui";
import { useChat } from "../../src/lib/chat";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { Button, colors, OfflineBanner } from "../../src/ui";

/** The chat page (spec 15.2): the message list with cards, tables and chips, and the input at the bottom. */
export default function Chat() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const { messages, busy, send, reset } = useChat();
  const [text, setText] = useState("");
  const [top, setTop] = useState(0);
  const box = useRef<View>(null);
  const list = useRef<ScrollView>(null);
  const newestReply = [...messages].reverse().find((message) => message.kind === "assistant");

  const submit = () => {
    const question = text.trim();
    if (!question || busy) return;
    setText("");
    void send({ text: question });
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
              <UserBubble key={message.id} text={message.text} />
            ) : (
              <AssistantBubble
                key={message.id}
                message={message}
                language={language}
                newest={message.id === newestReply?.id}
                busy={busy}
                onChoose={(slot, option) =>
                  void send({ choice: { slot, option_id: option.id }, label: option.label })
                }
              />
            ),
          )}
        </ScrollView>
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
        {messages.length > 0 && !busy ? (
          <View style={styles.newRow}>
            <Button label={t("chat.new")} kind="plain" onPress={reset} />
          </View>
        ) : null}
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
  newRow: { paddingHorizontal: 12, paddingBottom: 10 },
});
