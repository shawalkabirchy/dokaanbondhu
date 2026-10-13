import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Children, useContext, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
  type TextInputProps,
} from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { useHealth } from "./lib/health";
import { colors, radius, shadow, space, type } from "./theme";

// Small shared building blocks (spec D166): large touch targets and large text, usable with greasy hands
// (architecture, non-functional requirements). Icons are Material Community Icons, whose font the app carries.

export { colors };

export type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

export function Icon(props: { name: IconName; size?: number; color?: ColorValue }) {
  return (
    <MaterialCommunityIcons name={props.name} size={props.size ?? 22} color={props.color ?? colors.ink} />
  );
}

/** The phone's status-bar height: the pages draw their own top bar under it (0 where nothing provides it, as in tests). */
export function useTopInset(): number {
  return useContext(SafeAreaInsetsContext)?.top ?? 0;
}

/** The top bar of every page: its title, an optional back arrow, and buttons on the right. */
export function AppBar(props: { title: string; onBack?: () => void; right?: ReactNode }) {
  const { t } = useTranslation();
  const top = useTopInset();
  return (
    <View style={[styles.appbar, { paddingTop: top, height: 60 + top }]}>
      {props.onBack ? <IconButton icon="arrow-left" label={t("common.back")} onPress={props.onBack} /> : null}
      <Text style={[styles.appbarTitle, !props.onBack && { marginLeft: space.sm }]} numberOfLines={1}>
        {props.title}
      </Text>
      {props.right}
    </View>
  );
}

export function OfflineBanner() {
  const { t } = useTranslation();
  const { online, checking, starting } = useHealth();
  if (online || checking) return null;
  return (
    <View style={[styles.banner, starting ? styles.bannerInfo : styles.bannerWarn]} accessibilityRole="alert">
      {/* A server that has not answered yet may be waking (about a minute on Render), not offline (D164). */}
      {starting ? (
        <ActivityIndicator color={colors.infoInk} />
      ) : (
        <Icon name="cloud-off-outline" color={colors.warnInk} />
      )}
      <Text style={[styles.bannerText, { color: starting ? colors.infoInk : colors.warnInk }]}>
        {t(starting ? "offline.starting" : "offline.banner")}
      </Text>
    </View>
  );
}

// Android draws the app under the keyboard (edge-to-edge), so the page makes room itself and the focused field
// stays visible (D82). KeyboardAvoidingView measures itself within its parent, so the offset adds whatever is above
// the page on screen (the top bar).
export function KeyboardRoom({ children }: { children: ReactNode }) {
  const [top, setTop] = useState(0);
  const box = useRef<View>(null);
  return (
    <View ref={box} style={styles.flex} onLayout={() => box.current?.measureInWindow((_x, y) => setTop(y))}>
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={top}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

/** A page: its top bar, the offline banner and the scrolling content; pulled down to refresh when it can. */
export function Screen(props: {
  title: string;
  children: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** For a page that scrolls to a part of itself (setup's step list). */
  scrollRef?: Ref<ScrollView>;
}) {
  return (
    <View style={styles.page}>
      <AppBar title={props.title} onBack={props.onBack} right={props.right} />
      <KeyboardRoom>
        <OfflineBanner />
        <ScrollView
          ref={props.scrollRef}
          contentContainerStyle={styles.screen}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            props.onRefresh ? (
              <RefreshControl
                refreshing={props.refreshing ?? false}
                onRefresh={props.onRefresh}
                colors={[colors.green]}
              />
            ) : undefined
          }
        >
          {props.children}
        </ScrollView>
      </KeyboardRoom>
    </View>
  );
}

/** A section's title on a page. */
export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

/** A small grey label above a group of rows. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.groupLabel}>{children}</Text>;
}

export function Note({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "danger" | "ok" | "warn";
}) {
  const color =
    tone === "danger"
      ? colors.danger
      : tone === "ok"
        ? colors.greenInk
        : tone === "warn"
          ? colors.warnInk
          : colors.muted;
  return <Text style={[styles.note, { color }]}>{children}</Text>;
}

export type Tone = "green" | "red" | "amber" | "grey" | "blue";

const TONES: Record<Tone, { bg: string; ink: string }> = {
  green: { bg: colors.greenSoft, ink: colors.greenInk },
  red: { bg: colors.dangerSoft, ink: colors.danger },
  amber: { bg: colors.warnSoft, ink: colors.warnInk },
  grey: { bg: colors.chip, ink: "#3b444c" },
  blue: { bg: colors.infoSoft, ink: colors.infoInk },
};

/** A small coloured label: in stock, done, owner. */
export function Badge(props: { label: string; tone?: Tone; icon?: IconName; dot?: boolean }) {
  const tone = TONES[props.tone ?? "grey"];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      {props.dot ? <View style={[styles.dot, { backgroundColor: tone.ink }]} /> : null}
      {props.icon ? <Icon name={props.icon} size={16} color={tone.ink} /> : null}
      <Text style={[styles.badgeText, { color: tone.ink }]}>{props.label}</Text>
    </View>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger";
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
}) {
  const kind = props.kind ?? "primary";
  const ink = kind === "primary" ? colors.white : kind === "danger" ? colors.danger : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled, busy: !!props.loading }}
      disabled={props.disabled || props.loading}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.small && styles.buttonSmall,
        kind === "primary" ? styles.buttonPrimary : styles.buttonPlain,
        kind === "danger" && styles.buttonDanger,
        (pressed || props.disabled) && styles.pressed,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator color={ink} />
      ) : props.icon ? (
        <Icon name={props.icon} size={props.small ? 18 : 20} color={ink} />
      ) : null}
      <Text style={[styles.buttonText, props.small && styles.buttonTextSmall, { color: ink }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A round button with only an icon; its label is read out by screen readers. */
export function IconButton(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  on?: boolean;
  disabled?: boolean;
  color?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: !!props.on, disabled: !!props.disabled }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={props.onPress}
      style={({ pressed }) => [styles.iconButton, props.on && styles.iconButtonOn, pressed && styles.pressed]}
    >
      <Icon name={props.icon} color={props.on ? colors.greenInk : (props.color ?? colors.ink)} />
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string; right?: ReactNode }) {
  const { label, right, style, ...input } = props;
  const [focused, setFocused] = useState(false);
  const focus = {
    onFocus: (event: Parameters<NonNullable<TextInputProps["onFocus"]>>[0]) => {
      setFocused(true);
      input.onFocus?.(event);
    },
    onBlur: (event: Parameters<NonNullable<TextInputProps["onBlur"]>>[0]) => {
      setFocused(false);
      input.onBlur?.(event);
    },
  };
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {right ? (
        <View style={[styles.input, styles.inputRow, focused && styles.inputFocused]}>
          <TextInput
            style={styles.inputInner}
            placeholderTextColor={colors.faint}
            accessibilityLabel={label}
            {...input}
            {...focus}
          />
          {right}
        </View>
      ) : (
        <TextInput
          style={[styles.input, focused && styles.inputFocused, style]}
          placeholderTextColor={colors.faint}
          accessibilityLabel={label}
          {...input}
          {...focus}
        />
      )}
    </View>
  );
}

/** Choices as rounded buttons, the chosen one green; they wrap onto more lines. */
export function Chips<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.chips}>
      {props.options.map((option) => {
        const on = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChange(option.value)}
            style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
          >
            {on ? <Icon name="check" size={18} color={colors.white} /> : null}
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Two or three short choices side by side, such as বাংলা | English. */
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {props.options.map((option) => {
        const on = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChange(option.value)}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A white rounded card; with `rows`, its children are separated by thin lines. */
export function Card(props: { children: ReactNode; rows?: boolean; padded?: boolean }) {
  const children = Children.toArray(props.children).filter(Boolean);
  return (
    <View style={[styles.card, props.padded && styles.cardPadded]}>
      {props.rows
        ? children.map((child, index) => (
            <View key={index} style={index > 0 ? styles.separated : undefined}>
              {child}
            </View>
          ))
        : props.children}
    </View>
  );
}

/** One row of a card: an icon in a soft square, a title and a line under it, and something on the right. */
export function ListRow(props: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  tone?: Tone;
  right?: ReactNode;
  chevron?: boolean;
  danger?: boolean;
  onPress?: () => void;
}) {
  const tone = props.tone ? TONES[props.tone] : { bg: colors.chip, ink: colors.ink };
  const body = (
    <>
      {props.icon ? (
        <View style={[styles.rowIcon, { backgroundColor: tone.bg }]}>
          <Icon name={props.icon} color={tone.ink} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, props.danger && { color: colors.danger }]}>{props.title}</Text>
        {props.subtitle ? <Text style={styles.rowSubtitle}>{props.subtitle}</Text> : null}
      </View>
      {props.right}
      {props.chevron ? <Icon name="chevron-right" color={colors.faint} /> : null}
    </>
  );
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: colors.chip }]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={styles.listRow}>{body}</View>
  );
}

/** What an empty list says, with a soft icon. */
export function EmptyState(props: { icon: IconName; text: string }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={props.icon} size={30} color={colors.greenInk} />
      </View>
      <Text style={styles.emptyText}>{props.text}</Text>
    </View>
  );
}

/** Asks before something that is hard to take back (signing out, turning a login off): true for yes. */
export function confirmFirst(title: string, message: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      title,
      message,
      [
        { text: no, style: "cancel", onPress: () => resolve(false) },
        { text: yes, style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.page },
  screen: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  appbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderColor: colors.line,
  },
  appbarTitle: { flex: 1, fontSize: type.title, fontWeight: "700", color: colors.ink },
  banner: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  bannerInfo: { backgroundColor: colors.infoSoft },
  bannerWarn: { backgroundColor: colors.warnSoft },
  bannerText: { flex: 1, fontSize: type.small },
  heading: { fontSize: type.heading, fontWeight: "700", color: colors.ink, marginTop: space.sm },
  groupLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.muted,
    marginTop: space.sm,
    marginBottom: -space.xs,
    marginHorizontal: space.xs,
  },
  note: { fontSize: type.small },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  badgeText: { fontSize: 14, fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  button: {
    minHeight: 54,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingHorizontal: 18,
  },
  buttonSmall: { minHeight: 44, borderRadius: radius.sm, paddingHorizontal: space.md },
  buttonPrimary: { backgroundColor: colors.green },
  buttonPlain: { backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.line },
  buttonDanger: { borderColor: "#f2c3be" },
  buttonText: { fontSize: type.body, fontWeight: "700" },
  buttonTextSmall: { fontSize: type.small, fontWeight: "600" },
  pressed: { opacity: 0.6 },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  iconButtonOn: { backgroundColor: colors.greenSoft },
  field: { gap: 6 },
  label: { fontSize: type.small, fontWeight: "600", color: colors.muted },
  input: {
    minHeight: 54,
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    fontSize: type.body,
    color: colors.ink,
    backgroundColor: colors.card,
  },
  inputFocused: { borderColor: colors.green },
  inputRow: { flexDirection: "row", alignItems: "center", paddingRight: space.xs },
  inputInner: { flex: 1, minHeight: 50, fontSize: type.body, color: colors.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.lg,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  chipOn: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { fontSize: type.small + 1, color: colors.ink },
  chipTextOn: { color: colors.white, fontWeight: "600" },
  segmented: { flexDirection: "row", backgroundColor: colors.chip, borderRadius: 12, padding: 3, gap: 3 },
  segment: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentOn: { backgroundColor: colors.card, ...shadow },
  segmentText: { fontSize: type.small, fontWeight: "600", color: colors.muted },
  segmentTextOn: { color: colors.greenInk },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    overflow: "hidden",
    ...shadow,
  },
  cardPadded: { padding: space.lg, gap: space.sm },
  /** A padded card for a page's own content (setup's connection, words and actions). */
  box: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    ...shadow,
  },
  separated: { borderTopWidth: 1, borderColor: colors.line },
  listRow: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: type.body, fontWeight: "600", color: colors.ink },
  rowSubtitle: { fontSize: 14, color: colors.muted, marginTop: 2 },
  empty: { alignItems: "center", gap: space.md, paddingVertical: space.xxl, paddingHorizontal: space.lg },
  emptyIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.greenSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: { fontSize: type.small + 1, color: colors.muted, textAlign: "center" },
});
