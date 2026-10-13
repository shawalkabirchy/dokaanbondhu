import type { UserView } from "@dokaanbondhu/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, ApiError } from "../../src/lib/api";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { colors, space, type } from "../../src/theme";
import {
  Badge,
  Button,
  Card,
  confirmFirst,
  EmptyState,
  Field,
  Heading,
  Icon,
  Note,
  Screen,
} from "../../src/ui";

/**
 * Staff (owner only, spec 15.2, D166): the list, add a login (name, email, password) from "নতুন স্টাফ", turn a login
 * off (asked first) or on again.
 */
export default function Staff() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["staff"], queryFn: () => api<{ staff: UserView[] }>("/staff") });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "" });
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);

  const errorText = (error: unknown) =>
    error instanceof ApiError && error.body
      ? language === "bn"
        ? error.body.message_bn
        : error.body.message_en
      : t("common.error");

  const create = useMutation({
    mutationFn: () =>
      api("/staff", {
        method: "POST",
        body: {
          name: form.name,
          email: form.email.trim(),
          password: form.password,
          ...(form.phone ? { phone: form.phone } : {}),
        },
      }),
    onSuccess: async () => {
      setForm({ name: "", email: "", password: "", phone: "" });
      setAdding(false);
      setMessage({ text: t("staff.created"), tone: "ok" });
      await queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
    onError: (error) => setMessage({ text: errorText(error), tone: "danger" }),
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: UserView["status"] }) =>
      api(`/staff/${input.id}`, { method: "PATCH", body: { status: input.status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["staff"] }),
  });

  const toggle = async (user: UserView) => {
    if (user.status === "active") {
      const yes = await confirmFirst(
        t("staff.disable_ask", { name: user.name }),
        t("staff.disable_ask_text"),
        t("staff.disable"),
        t("common.cancel"),
      );
      if (!yes) return;
    }
    setStatus.mutate({ id: user.id, status: user.status === "active" ? "disabled" : "active" });
  };

  const staff = list.data?.staff ?? [];
  return (
    <Screen
      title={t("staff.title")}
      right={
        adding ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setMessage(null);
              setAdding(true);
            }}
            style={({ pressed }) => [styles.add, pressed && { opacity: 0.6 }]}
          >
            <Icon name="plus" size={20} color={colors.white} />
            <Text style={styles.addText}>{t("staff.add_button")}</Text>
          </Pressable>
        )
      }
    >
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
      {adding ? (
        <Card padded>
          <Heading>{t("staff.add")}</Heading>
          <Field
            label={t("staff.name")}
            value={form.name}
            onChangeText={(name) => setForm({ ...form, name })}
          />
          <Field
            label={t("staff.email")}
            value={form.email}
            onChangeText={(email) => setForm({ ...form, email })}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <Field
            label={t("staff.password")}
            value={form.password}
            onChangeText={(password) => setForm({ ...form, password })}
            secureTextEntry
          />
          <Field
            label={t("staff.phone")}
            value={form.phone}
            onChangeText={(phone) => setForm({ ...form, phone })}
            keyboardType="phone-pad"
          />
          <Button
            label={t("staff.create")}
            icon="account-plus-outline"
            onPress={() => create.mutate()}
            loading={create.isPending}
            disabled={!form.name || !form.email || form.password.length < 8}
          />
          <Button label={t("common.cancel")} kind="plain" onPress={() => setAdding(false)} />
        </Card>
      ) : null}

      {staff.filter((user) => user.role === "staff").length === 0 && !list.isLoading ? (
        <EmptyState icon="account-group-outline" text={t("staff.none")} />
      ) : null}
      {staff.length ? (
        <Card rows>
          {staff.map((user) => {
            const off = user.status !== "active";
            return (
              <View key={user.id} style={styles.row}>
                <View style={[styles.avatar, off && styles.avatarOff]}>
                  <Text style={[styles.initial, off && styles.initialOff]}>{user.name.trim().charAt(0)}</Text>
                </View>
                <View style={styles.text}>
                  <Text style={[styles.name, off && styles.nameOff]}>{user.name}</Text>
                  <Text style={styles.email}>{user.email}</Text>
                  <Badge
                    label={
                      user.role === "owner" ? t("staff.owner") : t(off ? "staff.disabled" : "staff.active")
                    }
                    tone={user.role === "owner" || !off ? "green" : "grey"}
                    dot={user.role !== "owner"}
                  />
                </View>
                {user.role === "staff" ? (
                  <Button
                    small
                    kind={off ? "plain" : "danger"}
                    label={t(off ? "staff.enable" : "staff.disable")}
                    onPress={() => void toggle(user)}
                    disabled={setStatus.isPending}
                  />
                ) : null}
              </View>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  add: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: colors.green,
    marginRight: space.xs,
  },
  addText: { fontSize: type.small, fontWeight: "700", color: colors.white },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, padding: 14 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.greenSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarOff: { backgroundColor: colors.chip },
  initial: { fontSize: type.heading, fontWeight: "700", color: colors.greenInk },
  initialOff: { color: "#5d666e" },
  text: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontSize: type.body, fontWeight: "600", color: colors.ink },
  nameOff: { color: colors.muted },
  email: { fontSize: 14, color: colors.muted },
});
