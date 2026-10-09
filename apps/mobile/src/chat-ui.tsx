import type { Remembered, RememberedKey } from "@dokaanbondhu/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AssistantMessage, ChoicesEvent, ConfirmEvent, PartCard, TableEvent } from "./lib/chat-store";
import { numberText, stockText, takaText } from "./lib/money";
import type { Language } from "./lib/settings-store";
import { colors } from "./ui";

// What a reply shows (spec 15.2): its text, part cards, result tables, choice chips and the confirmation sheet. Money
// arrives in whole taka (D110); large text and large touch targets.

const PRICE_TIERS = ["retail", "paikari", "garage", "wholesale"] as const;

export function PartCards({ parts, language }: { parts: PartCard[]; language: Language }) {
  const { t } = useTranslation();
  return (
    <View style={styles.cards}>
      {parts.map((part) => {
        const inStock = part.stock === null || part.stock > 0;
        return (
          <View key={part.host_part_id} style={styles.card} testID="part-card">
            <Text style={styles.cardTitle}>
              {language === "bn" && part.name_bn ? part.name_bn : part.name}
            </Text>
            {part.quality ? (
              <Text style={styles.cardLine}>
                {t(`chat.quality.${part.quality}`, { defaultValue: part.quality })}
              </Text>
            ) : null}
            <Text style={[styles.cardLine, !inStock && styles.danger]}>
              {t("chat.stock")}:{" "}
              {part.stock === null
                ? "—"
                : inStock
                  ? stockText(part.stock, part.unit, language)
                  : t("chat.out")}
            </Text>
            {PRICE_TIERS.filter((tier) => part.price_taka[tier] !== undefined).map((tier) => (
              <Text key={tier} style={styles.cardLine}>
                {t(`chat.prices.${tier}`)}: {takaText(part.price_taka[tier]!, language)}
              </Text>
            ))}
            {part.rack ? (
              <Text style={styles.cardStrong}>
                {t("chat.rack")}: {part.rack}
              </Text>
            ) : null}
            {!part.fitment_verified ? <Text style={styles.warn}>{t("chat.no_fitment")}</Text> : null}
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
          <View style={styles.tableRow}>
            {table.columns.map((column) => (
              <Text key={column.key} style={[styles.tableCell, styles.tableHead]}>
                {column.label}
              </Text>
            ))}
          </View>
          {table.rows.map((row, index) => (
            <View key={index} style={styles.tableRow}>
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
      {table.truncated ? <Text style={styles.muted}>{t("chat.more_rows")}</Text> : null}
    </View>
  );
}

export function ChoiceChips(props: {
  choices: ChoicesEvent;
  active: boolean;
  onChoose: (option: { id: string; label: string }) => void;
}) {
  return (
    <View style={styles.chips}>
      {props.choices.options.map((option) => (
        <Pressable
          key={option.id}
          accessibilityRole="button"
          disabled={!props.active}
          onPress={() => props.onChoose(option)}
          style={({ pressed }) => [styles.chip, (!props.active || pressed) && styles.faded]}
        >
          <Text style={styles.chipText}>{option.label}</Text>
          {option.sublabel ? <Text style={styles.chipSub}>{option.sublabel}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/**
 * What the assistant remembers, above the input of both pages (D125, D126): the car and the customer, each while its
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
          <Text style={styles.memoryText}>{label}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(`memory.forget_${key}`)}
            hitSlop={8}
            onPress={() => props.onForget(key)}
            style={({ pressed }) => [styles.memoryForget, pressed && styles.faded]}
          >
            <Text style={styles.memoryX}>✕</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/**
 * The confirmation sheet (spec 9.9, 15.2): what will be saved, field by field (an unsure one in bold), the app's
 * warnings, and Yes or No while it lasts (60 s). Only the newest reply's sheet takes a decision; nothing is saved
 * before Yes.
 */
export function ConfirmSheet(props: {
  confirm: ConfirmEvent;
  active: boolean;
  onDecide: (decision: "yes" | "no") => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((Date.parse(props.confirm.expires_at) - now) / 1000));
  // The seconds count down only while a decision can still be taken.
  const live = props.active && left > 0;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return (
    <View style={styles.sheet}>
      <Text style={styles.sheetTitle}>{t("confirm.title")}</Text>
      {props.confirm.fields.map((field) => (
        <View key={field.label} style={styles.sheetRow}>
          <Text style={styles.sheetLabel}>{field.label}</Text>
          <Text style={[styles.sheetValue, field.highlight && styles.sheetUnsure]}>{field.value}</Text>
        </View>
      ))}
      {props.confirm.warnings.map((warning, index) => (
        <Text key={index} style={styles.warn}>
          {warning}
        </Text>
      ))}
      {live ? (
        <>
          <View style={styles.sheetButtons}>
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onDecide("yes")}
              style={({ pressed }) => [styles.decision, styles.yes, pressed && styles.faded]}
            >
              <Text style={[styles.decisionText, styles.yesText]}>{t("confirm.yes")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => props.onDecide("no")}
              style={({ pressed }) => [styles.decision, pressed && styles.faded]}
            >
              <Text style={styles.decisionText}>{t("confirm.no")}</Text>
            </Pressable>
          </View>
          <Text style={styles.muted}>{t("confirm.left", { count: left })}</Text>
        </>
      ) : props.active ? (
        <Text style={styles.muted}>{t("confirm.expired")}</Text>
      ) : null}
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
}) {
  const { t } = useTranslation();
  const { message } = props;
  const text = message.texts.filter(Boolean).join(" ");
  return (
    <View style={styles.reply}>
      {text ? (
        <View style={[styles.bubble, styles.assistantBubble]}>
          <Text style={styles.bubbleText}>{text}</Text>
        </View>
      ) : null}
      {/* The spinner shows only until the answer's text arrives; its audio may still be on the way (D101). */}
      {message.status && !message.done && !text ? (
        <View style={styles.statusRow}>
          <ActivityIndicator color={colors.green} />
          <Text style={styles.muted}>{t(message.status)}</Text>
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
          active={props.newest && !props.busy && !message.result}
          onDecide={(decision) => props.onDecide!(message.confirm!.action_id, decision)}
        />
      ) : null}
      {message.error ? <Text style={styles.danger}>{t(message.error)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  reply: { gap: 10, alignSelf: "stretch" },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, maxWidth: "88%" },
  userBubble: { backgroundColor: colors.green, alignSelf: "flex-end" },
  assistantBubble: { backgroundColor: colors.greenLight, alignSelf: "flex-start" },
  // No fixed lineHeight: with one, Android sized a short Bangla bubble ("দুই হাজার ষোল") for one line and drew its
  // last word on a second line the bubble did not show (D103).
  bubbleText: { fontSize: 18, color: colors.ink },
  userText: { color: colors.white },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  muted: { fontSize: 15, color: colors.muted },
  danger: { fontSize: 16, color: colors.danger },
  warn: { fontSize: 15, color: colors.warnInk, backgroundColor: colors.warnBg, padding: 6, borderRadius: 8 },
  cards: { gap: 10 },
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 14, gap: 4 },
  cardTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
  cardLine: { fontSize: 16, color: colors.ink },
  cardStrong: { fontSize: 18, fontWeight: "700", color: colors.green },
  table: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 10, gap: 6 },
  tableTitle: { fontSize: 16, fontWeight: "600", color: colors.ink },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.line },
  tableCell: { minWidth: 110, paddingVertical: 8, paddingHorizontal: 6, fontSize: 16, color: colors.ink },
  tableHead: { fontWeight: "700", color: colors.muted },
  number: { textAlign: "right" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  chip: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.green,
    justifyContent: "center",
  },
  chipText: { fontSize: 18, color: colors.green, fontWeight: "600" },
  chipSub: { fontSize: 14, color: colors.muted },
  faded: { opacity: 0.5 },
  sheet: { borderWidth: 2, borderColor: colors.green, borderRadius: 16, padding: 14, gap: 8 },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.ink },
  sheetRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sheetLabel: { fontSize: 16, color: colors.muted, minWidth: 90 },
  sheetValue: { fontSize: 18, color: colors.ink, flexShrink: 1 },
  sheetUnsure: { fontWeight: "700" },
  sheetButtons: { flexDirection: "row", gap: 12, marginTop: 4 },
  decision: {
    flex: 1,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  yes: { backgroundColor: colors.green },
  decisionText: { fontSize: 20, fontWeight: "700", color: colors.green },
  yesText: { color: colors.white },
  memory: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  memoryItem: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    backgroundColor: colors.greenLight,
    paddingLeft: 12,
  },
  memoryText: { fontSize: 16, color: colors.ink },
  memoryForget: { minWidth: 44, minHeight: 40, alignItems: "center", justifyContent: "center" },
  memoryX: { fontSize: 18, color: colors.muted, fontWeight: "700" },
});
