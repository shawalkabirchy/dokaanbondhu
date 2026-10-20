import type { Remembered, RememberedKey } from "@dokaanbondhu/contracts";
import { banglaDigits } from "@dokaanbondhu/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  ActionResultEvent,
  AssistantMessage,
  ChoicesEvent,
  ConfirmEvent,
  PartCard,
  TableEvent,
} from "./lib/chat-store";
import { numberText, stockText, takaText } from "./lib/money";
import { useDeviceSettings, type Language } from "./lib/settings-store";
import { colors, radius, shadow, space, type } from "./theme";
import { Badge, Icon, type IconName, type Tone } from "./ui";

// What a reply shows (spec 15.2, D166): its text, part cards, result tables, choice buttons, the confirmation sheet and,
// under a saved action, its undo. Money arrives in whole taka (D110); large text and large touch targets.

const PRICE_TIERS = ["retail", "paikari"] as const; // the only two price kinds the owner sees (D145)

/** A count in the app's language: Bangla digits in Bangla. */
function useDigits(): (value: number) => string {
  const language = useDeviceSettings((state) => state.language);
  return (value) => (language === "bn" ? banglaDigits(String(value)) : String(value));
}

export function PartCards({ parts, language }: { parts: PartCard[]; language: Language }) {
  const { t } = useTranslation();
  return (
    <View style={styles.cards}>
      {parts.map((part) => {
        const inStock = part.stock === null || part.stock > 0;
        return (
          <View key={part.host_part_id} style={styles.card} testID="part-card">
            <View style={styles.cardTop}>
              <Text style={styles.cardTitle}>
                {language === "bn" && part.name_bn ? part.name_bn : part.name}
              </Text>
              {part.quality ? (
                <Badge
                  label={t(`chat.quality.${part.quality}`, { defaultValue: part.quality })}
                  tone={part.quality === "genuine" ? "blue" : "grey"}
                />
              ) : null}
            </View>
            <View style={styles.cardRow}>
              {part.stock === null ? (
                <Badge label={`${t("chat.stock")}: —`} tone="grey" />
              ) : inStock ? (
                <Badge
                  label={`${t("chat.in_stock")} ${stockText(part.stock, part.unit, language)}`}
                  tone="green"
                  dot
                />
              ) : (
                <Badge label={t("chat.out")} tone="red" dot />
              )}
              {part.rack ? (
                <View style={styles.rack}>
                  <Icon name="map-marker-outline" size={18} />
                  <Text style={styles.rackText}>
                    {t("chat.rack")} {part.rack}
                  </Text>
                </View>
              ) : null}
            </View>
            {PRICE_TIERS.filter((tier) => part.price_taka[tier] !== undefined).map((tier) => (
              <View key={tier} style={[styles.cardRow, styles.priceRow]}>
                <Text style={styles.priceLabel}>
                  {t(`chat.prices.${tier}`)} {t("chat.price")}
                </Text>
                <Text style={styles.price}>{takaText(part.price_taka[tier]!, language)}</Text>
              </View>
            ))}
            {!part.fitment_verified ? (
              <Badge label={t("chat.no_fitment")} tone="amber" icon="alert-outline" />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function ResultTable({ table, language }: { table: TableEvent; language: Language }) {
  const { t } = useTranslation();
  const cell = (value: string | number | null, kind: TableEvent["columns"][number]["kind"]) => {
    if (value === null) return "—";
    if (typeof value === "number")
      return kind === "money" ? takaText(value, language) : numberText(value, language);
    return value;
  };
  return (
    <View style={styles.table} testID="result-table">
      {table.title ? <Text style={styles.tableTitle}>{table.title}</Text> : null}
      <ScrollView horizontal>
        <View>
          <View style={[styles.tableRow, styles.tableHeadRow]}>
            {table.columns.map((column) => (
              <Text key={column.key} style={[styles.tableCell, styles.tableHead]}>
                {column.label}
              </Text>
            ))}
          </View>
          {table.rows.map((row, index) => (
            <View key={index} style={[styles.tableRow, index % 2 === 1 && styles.tableStripe]}>
              {table.columns.map((column, at) => (
                <Text
                  key={column.key}
                  style={[
                    styles.tableCell,
                    column.kind !== "text" && column.kind !== "date" && styles.number,
                  ]}
                >
                  {cell(row[at] ?? null, column.kind)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {table.truncated ? <Text style={styles.tableMore}>{t("chat.more_rows")}</Text> : null}
    </View>
  );
}

/** The answers to a question as buttons: one per line when they carry a second line, else side by side. */
export function ChoiceChips(props: {
  choices: ChoicesEvent;
  active: boolean;
  onChoose: (option: { id: string; label: string }) => void;
}) {
  const stacked = props.choices.options.some((option) => option.sublabel);
  return (
    <View style={stacked ? styles.options : styles.chips}>
      {props.choices.options.map((option) => (
        <Pressable
          key={option.id}
          accessibilityRole="button"
          disabled={!props.active}
          onPress={() => props.onChoose(option)}
          style={({ pressed }) => [
            styles.chip,
            stacked && styles.option,
            (!props.active || pressed) && styles.faded,
          ]}
        >
          <Text style={styles.chipText}>{option.label}</Text>
          {option.sublabel ? <Text style={styles.chipSub}>{option.sublabel}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * What the assistant remembers, above the button or typing bar (D125, D126): the car and the customer, each while its
 * time lasts (checked every 30 s), with ✕ to forget it.
 */
export function MemoryLine(props: { remembered: Remembered; onForget: (key: RememberedKey) => void }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const shown = (["vehicle", "customer"] as const).flatMap((key) => {
    const item = props.remembered[key];
    return item && Date.parse(item.until) > now ? [{ key, label: item.label }] : [];
  });
  const showing = shown.length > 0;
  useEffect(() => {
    if (!showing) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [showing]);
  if (!showing) return null;
  return (
    <View style={styles.memory}>
      <Text style={styles.muted}>{t("memory.title")}</Text>
      {shown.map(({ key, label }) => (
        <View key={key} style={styles.memoryItem}>
          <Icon
            name={key === "vehicle" ? "car-outline" : "account-outline"}
            size={18}
            color={colors.greenInk}
          />
          <Text style={styles.memoryText}>{label}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(`memory.forget_${key}`)}
            hitSlop={8}
            onPress={() => props.onForget(key)}
            style={({ pressed }) => [styles.memoryForget, pressed && styles.faded]}
          >
            <Icon name="close" size={18} color={colors.greenInk} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const RESULT_LOOK: Record<ActionResultEvent["status"], { tone: Tone; icon: IconName }> = {
  done: { tone: "green", icon: "check-bold" },
  cancelled: { tone: "grey", icon: "close" },
  failed: { tone: "red", icon: "alert-circle-outline" },
  review: { tone: "amber", icon: "alert-outline" },
};

const HEAD_COLORS: Record<Tone, { bg: string; ink: string }> = {
  green: { bg: colors.greenSoft, ink: colors.greenInk },
  grey: { bg: colors.chip, ink: "#3b444c" },
  red: { bg: colors.dangerSoft, ink: colors.danger },
  amber: { bg: colors.warnSoft, ink: colors.warnInk },
  blue: { bg: colors.infoSoft, ink: colors.infoInk },
};

/**
 * The confirmation sheet (spec 9.9, 15.2, D166): what will be saved, field by field (an unsure one in amber), the
 * app's warnings, and Yes or No while it lasts (60 s, with a bar that shrinks). Only the newest reply's sheet takes a
 * decision; nothing is saved before Yes. Once decided it says what became of it: saved, cancelled, not saved, or to be
 * checked in the shop app.
 */
export function ConfirmSheet(props: {
  confirm: ConfirmEvent;
  active: boolean;
  onDecide: (decision: "yes" | "no") => void;
  result?: ActionResultEvent | null;
}) {
  const { t } = useTranslation();
  const digits = useDigits();
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((Date.parse(props.confirm.expires_at) - now) / 1000));
  const [total] = useState(() => Math.max(1, left));
  const result = props.result ?? null;
  // The seconds count down only while a decision can still be taken.
  const live = props.active && !result && left > 0;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const look = result ? RESULT_LOOK[result.status] : null;
  const head = look ? HEAD_COLORS[look.tone] : null;
  return (
    <View style={[styles.sheet, result && styles.sheetDone]}>
      <View style={[styles.sheetHead, head && { backgroundColor: head.bg }]}>
        <Icon
          name={look ? look.icon : "file-document-check-outline"}
          color={head ? head.ink : colors.white}
        />
        <Text style={[styles.sheetTitle, head && { color: head.ink }]}>
          {result ? t(`confirm.result_${result.status}`) : t("confirm.title")}
        </Text>
      </View>
      <View style={styles.sheetBody}>
        {props.confirm.fields.map((field, index) => (
          <View
            key={field.label}
            style={[
              styles.sheetRow,
              index === props.confirm.fields.length - 1 && styles.sheetRowLast,
              field.highlight && !result && styles.sheetUnsure,
            ]}
          >
            <Text style={styles.sheetLabel}>{field.label}</Text>
            <View style={styles.sheetValueBox}>
              <Text style={[styles.sheetValue, result && styles.sheetValueDone]}>{field.value}</Text>
              {field.highlight && !result ? (
                <Text style={styles.sheetUnsureTag}>{t("confirm.unsure")}</Text>
              ) : null}
            </View>
          </View>
        ))}
        {result
          ? null
          : props.confirm.warnings.map((warning, index) => (
              <View key={index} style={styles.warn}>
                <Icon name="alert-outline" size={18} color={colors.warnInk} />
                <Text style={styles.warnText}>{warning}</Text>
              </View>
            ))}
      </View>
      {live ? (
        <>
          <View style={styles.sheetButtons}>
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onDecide("yes")}
              style={({ pressed }) => [styles.decision, styles.yes, pressed && styles.faded]}
            >
              <Icon name="check-bold" color={colors.white} />
              <Text style={[styles.decisionText, styles.yesText]}>{t("confirm.yes")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onDecide("no")}
              style={({ pressed }) => [styles.decision, pressed && styles.faded]}
            >
              <Icon name="close-thick" />
              <Text style={styles.decisionText}>{t("confirm.no")}</Text>
            </Pressable>
          </View>
          <View style={styles.timer}>
            <View style={styles.bar}>
              <View
                style={[styles.barFill, { width: `${Math.round((100 * left) / total)}%` as `${number}%` }]}
              />
            </View>
            <View style={styles.timerRow}>
              <Text style={styles.timerText}>{t("confirm.say")}</Text>
              <Text style={styles.timerText}>{t("confirm.left", { seconds: digits(left) })}</Text>
            </View>
          </View>
        </>
      ) : props.active && !result ? (
        <Text style={[styles.muted, styles.expired]}>{t("confirm.expired")}</Text>
      ) : null}
    </View>
  );
}

/** ফিরিয়ে নিন under a saved action while it can still be undone (D38, D166), with the minutes left. */
function UndoButton(props: { until: number; disabled: boolean; onUndo: () => void }) {
  const { t } = useTranslation();
  const digits = useDigits();
  const [now, setNow] = useState(() => Date.now());
  const left = props.until - now;
  const open = left > 0;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);
  if (!open) return null;
  return (
    <View style={styles.undoRow}>
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={props.onUndo}
        style={({ pressed }) => [styles.undo, (pressed || props.disabled) && styles.faded]}
      >
        <Icon name="undo-variant" size={18} />
        <Text style={styles.undoText}>{t("history.undo")}</Text>
      </Pressable>
      <Text style={styles.muted}>{t("chat.undo_left", { minutes: digits(Math.ceil(left / 60_000)) })}</Text>
    </View>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <View style={[styles.bubble, styles.userBubble]}>
      <Text style={[styles.bubbleText, styles.userText]}>{text}</Text>
    </View>
  );
}

export function AssistantBubble(props: {
  message: AssistantMessage;
  language: Language;
  newest: boolean;
  busy: boolean;
  onChoose: (slot: string, option: { id: string; label: string }) => void;
  /** The confirmation sheet's Yes or No. */
  onDecide?: (actionId: string, decision: "yes" | "no") => void;
  /** What became of the sheet's action, from a later reply (D166). */
  result?: ActionResultEvent | null;
  /** ফিরিয়ে নিন under a saved action (D166). */
  onUndo?: (actionId: string) => void;
  /** The status in words while the turn runs; false where the line under the talk button says it (D166). */
  showStatus?: boolean;
}) {
  const { t } = useTranslation();
  const { message } = props;
  const text = message.texts.filter(Boolean).join(" ");
  const showStatus = props.showStatus ?? true;
  return (
    <View style={styles.reply}>
      {text ? (
        <View style={[styles.bubble, styles.assistantBubble]}>
          <Text style={styles.bubbleText}>{text}</Text>
        </View>
      ) : null}
      {/* The spinner shows only until the answer's text arrives; its audio may still be on the way (D101). */}
      {message.status && !message.done && !text ? (
        <View style={[styles.bubble, styles.assistantBubble, styles.statusRow]}>
          <ActivityIndicator color={colors.green} />
          {showStatus ? <Text style={styles.muted}>{t(message.status)}</Text> : null}
        </View>
      ) : null}
      {message.cards.length ? <PartCards parts={message.cards} language={props.language} /> : null}
      {message.tables.map((table, index) => (
        <ResultTable key={index} table={table} language={props.language} />
      ))}
      {message.choices ? (
        <ChoiceChips
          choices={message.choices}
          active={props.newest && !props.busy}
          onChoose={(option) => props.onChoose(message.choices!.slot, option)}
        />
      ) : null}
      {message.confirm && props.onDecide ? (
        <ConfirmSheet
          confirm={message.confirm}
          // A reply may report another action and bring a new sheet: a customer added inside a sale (D173), or a
          // corrected sheet in place of the old one. Only the sheet's own result decides it (D175).
          active={props.newest && !props.busy && message.result?.action_id !== message.confirm.action_id}
          result={props.result}
          onDecide={(decision) => props.onDecide!(message.confirm!.action_id, decision)}
        />
      ) : null}
      {message.result &&
      message.undoUntil &&
      props.onUndo &&
      // The other action's undo waits while this reply's sheet waits: the sale may be about to use the new customer.
      !(message.confirm && message.confirm.action_id !== message.result.action_id && !props.result) ? (
        <UndoButton
          until={message.undoUntil}
          disabled={props.busy}
          onUndo={() => props.onUndo!(message.result!.action_id)}
        />
      ) : null}
      {message.error ? (
        <View style={styles.error}>
          <Icon name="alert-circle-outline" size={20} color={colors.danger} />
          <Text style={styles.errorText}>{t(message.error)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  reply: { gap: space.sm + 2, alignSelf: "stretch" },
  bubble: { borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: space.sm + 2, maxWidth: "88%" },
  userBubble: { backgroundColor: colors.green, alignSelf: "flex-end", borderBottomRightRadius: 4 },
  assistantBubble: {
    backgroundColor: colors.card,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.line,
    borderBottomLeftRadius: 4,
  },
  // No fixed lineHeight: with one, Android sized a short Bangla bubble ("দুই হাজার ষোল") for one line and drew its
  // last word on a second line the bubble did not show (D103).
  bubbleText: { fontSize: type.body + 1, color: colors.ink },
  userText: { color: colors.white },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  muted: { fontSize: type.small, color: colors.muted },
  error: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    padding: space.sm + 2,
  },
  errorText: { flex: 1, fontSize: type.small + 1, color: colors.danger },
  warn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.sm,
    padding: space.sm + 2,
    marginTop: space.sm + 2,
  },
  warnText: { flex: 1, fontSize: type.small, color: colors.warnInk },
  cards: { gap: space.sm + 2 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg - 2,
    padding: 14,
    gap: space.sm + 2,
    ...shadow,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.sm },
  cardTitle: { flex: 1, fontSize: type.heading, fontWeight: "700", color: colors.ink },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  rack: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.chip,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 6,
  },
  rackText: { fontSize: type.body - 1, fontWeight: "700", color: colors.ink },
  priceRow: { borderTopWidth: 1, borderColor: colors.line, paddingTop: space.sm + 2 },
  priceLabel: { fontSize: type.small, color: colors.muted },
  price: { fontSize: 22, fontWeight: "700", color: colors.ink },
  table: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg - 2,
    overflow: "hidden",
    ...shadow,
  },
  tableTitle: {
    fontSize: type.small,
    fontWeight: "700",
    color: colors.ink,
    paddingHorizontal: 14,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
    borderColor: colors.line,
  },
  tableRow: { flexDirection: "row", borderTopWidth: 1, borderColor: colors.line },
  tableHeadRow: { backgroundColor: "#f1f4f2", borderTopWidth: 0 },
  tableStripe: { backgroundColor: "#fafbfa" },
  tableCell: {
    minWidth: 120,
    paddingVertical: 9,
    paddingHorizontal: space.md,
    fontSize: type.body - 1,
    color: colors.ink,
  },
  tableHead: { fontSize: 14, fontWeight: "600", color: colors.muted },
  tableMore: { fontSize: type.small, color: colors.muted, padding: space.md },
  number: { textAlign: "right", fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm + 2 },
  options: { gap: space.sm },
  chip: {
    minHeight: 54,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.green,
    backgroundColor: colors.card,
    justifyContent: "center",
  },
  option: { alignSelf: "stretch" },
  chipText: { fontSize: type.body, color: colors.greenInk, fontWeight: "700" },
  chipSub: { fontSize: 14, color: colors.muted },
  faded: { opacity: 0.5 },
  sheet: {
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.green,
    borderRadius: radius.lg,
    overflow: "hidden",
    ...shadow,
  },
  sheetDone: { borderWidth: 1, borderColor: colors.line },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.green,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  sheetTitle: { flex: 1, fontSize: type.heading, fontWeight: "700", color: colors.white },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.xs },
  sheetRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: space.md,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
    borderColor: colors.line,
  },
  sheetRowLast: { borderBottomWidth: 0 },
  sheetUnsure: {
    backgroundColor: colors.warnSoft,
    marginHorizontal: -space.lg,
    paddingHorizontal: space.lg,
    borderColor: "#f3dcb0",
  },
  sheetLabel: { fontSize: type.small + 1, color: colors.muted },
  sheetValueBox: { flexShrink: 1, alignItems: "flex-end" },
  sheetValue: { fontSize: type.body, fontWeight: "600", color: colors.ink, textAlign: "right" },
  sheetValueDone: { fontSize: type.small, fontWeight: "500" },
  sheetUnsureTag: { fontSize: 13, fontWeight: "600", color: colors.warnInk },
  sheetButtons: {
    flexDirection: "row",
    gap: space.sm + 2,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  decision: {
    flex: 1,
    minHeight: 58,
    flexDirection: "row",
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  yes: { backgroundColor: colors.green, borderColor: colors.green },
  decisionText: { fontSize: type.title, fontWeight: "700", color: colors.ink },
  yesText: { color: colors.white },
  timer: { paddingHorizontal: space.lg, paddingTop: space.sm + 2, paddingBottom: 14, gap: 6 },
  bar: { height: 6, borderRadius: 3, backgroundColor: "#e5ebe8", overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.green },
  timerRow: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  timerText: { fontSize: 14, color: colors.muted },
  expired: { paddingHorizontal: space.lg, paddingBottom: 14 },
  undoRow: { flexDirection: "row", alignItems: "center", gap: space.sm + 2 },
  undo: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  undoText: { fontSize: type.small, fontWeight: "600", color: colors.ink },
  memory: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  memoryItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.greenSoft,
    paddingLeft: space.sm + 2,
  },
  memoryText: { fontSize: type.small, fontWeight: "600", color: colors.greenInk },
  memoryForget: { minWidth: 40, minHeight: 36, alignItems: "center", justifyContent: "center" },
});
