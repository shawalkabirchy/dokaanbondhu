import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { ASK_AGAIN, banglaDigits } from "@dokaanbondhu/core";
import * as Crypto from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AssistantBubble, MemoryLine, UserBubble } from "../../src/chat-ui";
import { phonePlayer, playAskAgain, stopPlayback, usePlayback } from "../../src/lib/audio";
import { useChat } from "../../src/lib/chat";
import type { ActionResultEvent } from "../../src/lib/chat-store";
import { buzz } from "../../src/lib/haptics";
import { useHealth, wakeSpeech } from "../../src/lib/health";
import { ReplyPlayer } from "../../src/lib/reply-player";
import { useMe } from "../../src/lib/session";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { usePushToTalk } from "../../src/lib/use-push-to-talk";
import { colors, radius, space, type } from "../../src/theme";
import { AppBar, Badge, Icon, IconButton, KeyboardRoom, OfflineBanner, type Tone } from "../../src/ui";

// The assistant page (spec 15.2, D125, D166): voice and typing on one page over one conversation, so a question asked
// by voice can be finished by typing. At the bottom the round talk button (hold it and speak, src/lib/use-push-to-talk)
// with a keyboard button beside it, or the typing bar; one line under the button says what is happening: listening,
// understanding, searching, speaking (with a stop button), and the notes of D111 and D164. While the speech worker
// wakes the page says voice is getting ready (the button still works), then that it is ready; while the page is in
// front it keeps the worker awake (D164). Typed questions are spoken only while the speaker is on (D88); a choice or
// Yes and No is answered the way the last question was asked.

/** While the page is in front the speech worker is woken this often, since Modal sleeps after 5 idle minutes (D164). */
const KEEP_AWAKE_MS = 4 * 60_000;
/** How long "voice is ready" shows once the speech worker has woken (D164). */
const READY_MS = 5000;

const EXAMPLES: { key: string; tone: Tone }[] = [
  { key: "find", tone: "green" },
  { key: "price", tone: "blue" },
  { key: "due", tone: "amber" },
  { key: "sale", tone: "grey" },
];

export default function Assistant() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const { health, micAllowed, starting, speechTrouble, speechWaking, refresh } = useHealth();
  const { messages, busy, runTurn, ensureConversation, send, decide, undo, reset, note, remembered, forget } =
    useChat();
  /** False when the developer has switched reading aloud off (AI_SPEAK=off, D114). */
  const speaks = useMe().data?.providers.speaks ?? true;
  const playing = usePlayback((state) => state.playing);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  /** The speaker: typed questions are answered aloud too (off at first). */
  const [speak, setSpeak] = useState(false);
  const lastAsked = useRef<"voice" | "typed">("voice");
  const player = useRef<ReplyPlayer | null>(null);
  const list = useRef<ScrollView>(null);
  const [ready, setReady] = useState(false);
  const wasWaking = useRef(false);
  const newestReply = [...messages].reverse().find((message) => message.kind === "assistant");
  // What became of each action, from the reply to its Yes or No, so its sheet can say so (D166).
  const results = new Map<string, ActionResultEvent>();
  for (const message of messages)
    if (message.kind === "assistant" && message.result) results.set(message.result.action_id, message.result);

  /** A new reply's audio player; the previous one stops. */
  function playerTap(): (event: ReplyEvent) => void {
    player.current?.stop();
    const current = new ReplyPlayer(phonePlayer, Crypto.randomUUID());
    player.current = current;
    return (event) => {
      if (event.type === "audio") current.add(event.seq, event.data);
      if (event.type === "done") current.end();
    };
  }

  /** Stops the answer being spoken (the stop button, a new press, a new conversation). */
  function stopReply() {
    player.current?.stop();
    stopPlayback();
  }

  /** A clip too quiet to send: "আবার বলবেন?" as text, and as the bundled sound unless speaking is off (D114). */
  function askAgain() {
    note(ASK_AGAIN);
    if (speaks) playAskAgain();
  }

  const talk = usePushToTalk({
    busy,
    ensureConversation,
    runTurn,
    askAgain,
    replyTap: playerTap,
    stopReply,
    afterTurn: () => {
      if (speechTrouble) void refresh(); // a turn that worked clears the warning at once
    },
  });

  useEffect(() => () => player.current?.stop(), []);

  // "Voice is ready" for a few seconds once the worker that was waking answers (D164).
  useEffect(() => {
    if (speechWaking) {
      wasWaking.current = true;
      setReady(false);
    } else if (wasWaking.current) {
      wasWaking.current = false;
      if (health.speech === "ok") setReady(true);
    }
  }, [speechWaking, health.speech]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setReady(false), READY_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  // Only while this page is in front and the app is in use: a closed app lets the worker sleep (D164).
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void wakeSpeech(refresh);
      }, KEEP_AWAKE_MS);
      return () => clearInterval(timer);
    }, [refresh]),
  );

  // The seconds held, under the button while recording.
  const [held, setHeld] = useState(0);
  useEffect(() => {
    if (!talk.recording) {
      setHeld(0);
      return;
    }
    const since = Date.now();
    const timer = setInterval(() => setHeld(Math.floor((Date.now() - since) / 1000)), 250);
    return () => clearInterval(timer);
  }, [talk.recording]);

  // The ring around the button: it grows with the voice and breathes while recording (D166).
  const loudness = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(loudness, {
      toValue: talk.recording ? Math.min(1, talk.level * 10) : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [loudness, talk.level, talk.recording]);
  useEffect(() => {
    if (!talk.recording) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, talk.recording]);

  /** Sending options for a typed question: with the speaker on, the reply's audio is played by a new player. */
  const typedOptions = () => {
    player.current?.stop();
    if (!speak || !speaks) return {};
    return { speak: true, tap: playerTap() };
  };
  /** A choice or Yes and No: spoken after a voice question, otherwise as the speaker says. */
  const replyOptions = () =>
    lastAsked.current === "voice" ? { speak: true, tap: playerTap() } : typedOptions();

  const submit = () => {
    const question = text.trim();
    if (!question || busy) return;
    setText("");
    lastAsked.current = "typed";
    void send({ text: question }, typedOptions());
  };

  const pressIn = () => {
    buzz("press");
    lastAsked.current = "voice";
    return talk.onPressIn();
  };
  const pressOut = () => {
    if (talk.recording) buzz("release");
    void talk.onPressOut();
  };

  const clock = (seconds: number) => {
    const shown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return language === "bn" ? banglaDigits(shown) : shown;
  };

  const newestText = newestReply?.kind === "assistant" ? newestReply.texts.filter(Boolean).join("") : "";
  const working =
    busy && newestReply?.kind === "assistant" && newestReply.status && !newestReply.done && !newestText
      ? newestReply.status
      : null;

  /** The one line under the talk button: what is happening now. */
  const statusLine = () => {
    if (talk.recording)
      return (
        <View style={styles.statusColumn}>
          <View style={styles.statusRow}>
            <Text style={[styles.status, styles.statusRec]}>{t("status.listening")}</Text>
            <Text style={[styles.status, styles.statusRec]}>{t("assistant.release")}</Text>
          </View>
          <Text style={styles.held}>{t("assistant.held", { seconds: clock(held) })}</Text>
        </View>
      );
    if (working)
      return (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.green} />
          <Text style={styles.status}>{t(working)}</Text>
        </View>
      );
    if (playing) return speakingLine();
    // Never off while recording: a question being asked is always finished and sent (D111).
    if (!micAllowed)
      return (
        <Text style={[styles.status, !starting && styles.statusDanger]}>
          {/* While starting, the banner above says the assistant is starting (D164). */}
          {starting ? t("status.starting") : t("offline.mic_off")}
        </Text>
      );
    if (speechTrouble)
      return <Text style={[styles.status, styles.statusWarn]}>{t("offline.speech_trouble")}</Text>;
    if (speechWaking)
      return (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.muted} />
          <Text style={[styles.status, styles.statusWrap]}>{t("voice.waking")}</Text>
        </View>
      );
    if (ready)
      return (
        <View style={styles.statusRow}>
          <Icon name="check" size={18} color={colors.greenInk} />
          <Text style={[styles.status, styles.statusOk]}>{t("voice.ready")}</Text>
        </View>
      );
    return <Text style={styles.status}>{t("voice.hold")}</Text>;
  };

  const speakingLine = () => (
    <View style={styles.statusRow}>
      <Icon name="volume-high" size={20} color={colors.greenInk} />
      <Text style={[styles.status, styles.statusOk]}>{t("status.speaking")}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={stopReply}
        style={({ pressed }) => [styles.stop, pressed && styles.pressed]}
      >
        <Icon name="stop" size={18} color={colors.white} />
        <Text style={styles.stopText}>{t("assistant.stop")}</Text>
      </Pressable>
    </View>
  );

  const micStyle = talk.recording
    ? styles.micRec
    : !micAllowed
      ? styles.micOff
      : busy
        ? styles.micBusy
        : null;

  return (
    <View style={styles.page}>
      <AppBar
        title={t("assistant.title")}
        right={
          <>
            {speaks ? (
              <IconButton
                icon={speak ? "volume-high" : "volume-off"}
                label={t("chat.speak")}
                on={speak}
                onPress={() => setSpeak(!speak)}
              />
            ) : null}
            {messages.length > 0 && !busy && !talk.recording ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  stopReply();
                  reset();
                  setText("");
                }}
                style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
              >
                <Icon name="message-plus-outline" size={18} />
                <Text style={styles.newChatText}>{t("chat.new")}</Text>
              </Pressable>
            ) : null}
          </>
        }
      />
      <KeyboardRoom>
        <OfflineBanner />
        <ScrollView
          ref={list}
          style={styles.flex}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.welcome}>
                <View style={styles.welcomeIcon}>
                  <Icon name="microphone" size={32} color={colors.greenInk} />
                </View>
                <Text style={styles.welcomeTitle}>{t("assistant.empty_title")}</Text>
                <Text style={styles.welcomeText}>{t("assistant.empty_text")}</Text>
              </View>
              <Text style={styles.examplesTitle}>{t("assistant.examples_title")}</Text>
              {EXAMPLES.map((example) => (
                <Pressable
                  key={example.key}
                  accessibilityRole="button"
                  onPress={() => {
                    setText(t(`assistant.examples.${example.key}.text`));
                    setTyping(true);
                  }}
                  style={({ pressed }) => [styles.example, pressed && styles.pressed]}
                >
                  <Badge label={t(`assistant.examples.${example.key}.label`)} tone={example.tone} />
                  <Text style={styles.exampleText}>{t(`assistant.examples.${example.key}.text`)}</Text>
                  <Icon name="pencil-outline" size={18} color={colors.faint} />
                </Pressable>
              ))}
            </View>
          ) : null}
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
                showStatus={typing}
                result={message.confirm ? (results.get(message.confirm.action_id) ?? null) : null}
                onChoose={(slot, option) =>
                  void send({ choice: { slot, option_id: option.id }, label: option.label }, replyOptions())
                }
                onDecide={(actionId, decision) => {
                  if (decision === "yes") buzz("success");
                  void decide(actionId, decision, t(`confirm.${decision}`), replyOptions());
                }}
                onUndo={(actionId) => void undo(actionId, t("history.undo"))}
              />
            ),
          )}
        </ScrollView>
        {typing ? (
          <View style={styles.typingDock}>
            <MemoryLine remembered={remembered} onForget={(key) => void forget(key)} />
            {playing ? speakingLine() : null}
            <View style={styles.inputRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("assistant.mic")}
                onPress={() => {
                  Keyboard.dismiss();
                  setTyping(false);
                }}
                style={({ pressed }) => [styles.side, pressed && styles.pressed]}
              >
                <Icon name="microphone-outline" />
              </Pressable>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder={t("chat.placeholder")}
                placeholderTextColor={colors.faint}
                multiline
                maxLength={500}
                autoFocus
                onSubmitEditing={submit}
                accessibilityLabel={t("chat.placeholder")}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("chat.send")}
                accessibilityState={{ disabled: busy || !text.trim() }}
                disabled={busy || !text.trim()}
                onPress={submit}
                style={[styles.send, (busy || !text.trim()) && styles.sendOff]}
              >
                <Icon name="send" color={colors.white} />
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.dock}>
            <MemoryLine remembered={remembered} onForget={(key) => void forget(key)} />
            <View style={styles.micRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("assistant.keyboard")}
                disabled={talk.recording}
                onPress={() => setTyping(true)}
                style={({ pressed }) => [styles.side, pressed && styles.pressed]}
              >
                <Icon name="keyboard-outline" />
              </Pressable>
              <View style={styles.micWrap}>
                {talk.recording ? (
                  <>
                    <Animated.View
                      style={[
                        styles.ring,
                        styles.ringOuter,
                        {
                          transform: [
                            { scale: breath.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.04] }) },
                          ],
                        },
                      ]}
                    />
                    <Animated.View
                      style={[
                        styles.ring,
                        {
                          transform: [
                            {
                              scale: loudness.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1.18] }),
                            },
                          ],
                        },
                      ]}
                    />
                  </>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("voice.hold")}
                  // Never while recording: a question being asked is always finished and sent (D111).
                  disabled={!micAllowed && !talk.recording}
                  onPressIn={pressIn}
                  onPressOut={pressOut}
                  style={[styles.mic, micStyle]}
                >
                  <Icon
                    name="microphone"
                    size={40}
                    color={
                      !micAllowed && !talk.recording
                        ? "#6b747c"
                        : busy && !talk.recording
                          ? colors.greenInk
                          : colors.white
                    }
                  />
                </Pressable>
              </View>
              <View style={styles.sideSpace} />
            </View>
            <View style={styles.statusBox}>{statusLine()}</View>
          </View>
        )}
      </KeyboardRoom>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  flex: { flex: 1 },
  pressed: { opacity: 0.6 },
  list: { padding: space.lg, gap: space.md, flexGrow: 1 },
  newChat: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.line,
    marginRight: space.xs,
  },
  newChatText: { fontSize: type.small, fontWeight: "600", color: colors.ink },
  empty: { gap: space.md },
  welcome: { alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  welcomeIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.greenSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  welcomeTitle: { fontSize: 22, fontWeight: "700", color: colors.ink, marginTop: space.xs },
  welcomeText: { fontSize: type.small + 1, color: colors.muted, textAlign: "center" },
  examplesTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.muted,
    marginTop: space.sm,
    marginLeft: space.xs,
  },
  example: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: space.sm + 2,
  },
  exampleText: { flex: 1, fontSize: type.small + 1, color: colors.ink },
  dock: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    paddingTop: space.sm + 2,
    paddingBottom: space.md,
    gap: space.xs,
  },
  micRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  side: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  sideSpace: { width: 52 },
  micWrap: { width: 132, height: 112, alignItems: "center", justifyContent: "center" },
  ring: {
    position: "absolute",
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: "rgba(179, 38, 30, 0.16)",
  },
  ringOuter: { width: 132, height: 132, borderRadius: 66, backgroundColor: "rgba(179, 38, 30, 0.08)" },
  mic: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: colors.green,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  micRec: { backgroundColor: colors.danger, shadowColor: colors.danger },
  micBusy: { backgroundColor: "#c9d6cf", elevation: 0, shadowOpacity: 0 },
  micOff: { backgroundColor: "#d5dade", elevation: 0, shadowOpacity: 0 },
  statusBox: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  statusColumn: { alignItems: "center", gap: 2 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  status: { fontSize: type.small + 1, color: colors.muted, textAlign: "center" },
  statusWrap: { flexShrink: 1 },
  statusRec: { color: colors.danger, fontWeight: "700" },
  statusOk: { color: colors.greenInk, fontWeight: "600" },
  statusWarn: { color: colors.warnInk },
  statusDanger: { color: colors.danger },
  held: { fontSize: 14, color: colors.muted },
  stop: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: colors.ink,
  },
  stopText: { fontSize: type.small, fontWeight: "600", color: colors.white },
  typingDock: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: space.sm,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  input: {
    flex: 1,
    minHeight: 52,
    maxHeight: 140,
    borderWidth: 1.5,
    borderColor: colors.green,
    borderRadius: 26,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    fontSize: type.body,
    color: colors.ink,
  },
  send: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { backgroundColor: "#a9c9b8" },
});
