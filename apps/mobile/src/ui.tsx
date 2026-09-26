import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { useHealth } from "./lib/health";

// Small shared building blocks: large touch targets and large text, usable with greasy hands (architecture,
// non-functional requirements).

export const colors = {
  green: "#1f7a4d",
  greenLight: "#e6f3ec",
  ink: "#1b1f23",
  muted: "#5c6670",
  line: "#d9dee3",
  danger: "#b3261e",
  warnBg: "#fff4e5",
  warnInk: "#7a4b00",
  white: "#ffffff",
};

export function OfflineBanner() {
  const { t } = useTranslation();
  const { online, checking } = useHealth();
  if (online || checking) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.bannerText}>{t("offline.banner")}</Text>
    </View>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return (
    <View style={styles.flex}>
      <OfflineBanner />
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Note({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "danger" | "ok";
}) {
  const color = tone === "danger" ? colors.danger : tone === "ok" ? colors.green : colors.muted;
  return <Text style={[styles.note, { color }]}>{children}</Text>;
}

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "plain";
  disabled?: boolean;
}) {
  const primary = (props.kind ?? "primary") === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonPlain,
        (pressed || props.disabled) && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, !primary && styles.buttonTextPlain]}>{props.label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, ...input } = props;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.muted} {...input} />
    </View>
  );
}

export function Chips<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.chips}>
      {props.options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="button"
          accessibilityState={{ selected: option.value === props.value }}
          onPress={() => props.onChange(option.value)}
          style={[styles.chip, option.value === props.value && styles.chipOn]}
        >
          <Text style={[styles.chipText, option.value === props.value && styles.chipTextOn]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.white },
  screen: { padding: 20, gap: 14 },
  banner: { backgroundColor: colors.warnBg, padding: 12 },
  bannerText: { color: colors.warnInk, fontSize: 16 },
  heading: { fontSize: 22, fontWeight: "700", color: colors.ink, marginTop: 8 },
  note: { fontSize: 16, lineHeight: 22 },
  button: {
    minHeight: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  buttonPrimary: { backgroundColor: colors.green },
  buttonPlain: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  buttonText: { color: colors.white, fontSize: 18, fontWeight: "600" },
  buttonTextPlain: { color: colors.ink },
  pressed: { opacity: 0.6 },
  field: { gap: 6 },
  label: { fontSize: 16, color: colors.muted },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 18,
    color: colors.ink,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  chip: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: "center",
  },
  chipOn: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { fontSize: 17, color: colors.ink },
  chipTextOn: { color: colors.white },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 14, gap: 8 },
});
