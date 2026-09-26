import type { UserView } from "@dokaanbondhu/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { api, ApiError } from "../../src/lib/api";
import { useDeviceSettings } from "../../src/lib/settings-store";
import { Button, colors, Field, Heading, Note, Screen, styles } from "../../src/ui";

/** Staff (owner only, spec 15.2): the list, add a login (name, email, password), turn a login off or on. */
export default function Staff() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["staff"], queryFn: () => api<{ staff: UserView[] }>("/staff") });
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

  const staff = list.data?.staff ?? [];
  return (
    <Screen>
      <Heading>{t("staff.title")}</Heading>
      {staff.filter((user) => user.role === "staff").length === 0 && !list.isLoading ? (
        <Note>{t("staff.none")}</Note>
      ) : null}
      {staff.map((user) => (
        <View key={user.id} style={[styles.card, styles.row]}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: "600", color: colors.ink }}>{user.name}</Text>
            <Note>{user.email}</Note>
            <Note tone={user.status === "active" ? "ok" : "danger"}>
              {user.role === "owner"
                ? t("staff.owner")
                : t(user.status === "active" ? "staff.active" : "staff.disabled")}
            </Note>
          </View>
          {user.role === "staff" ? (
            <Button
              kind="plain"
              label={t(user.status === "active" ? "staff.disable" : "staff.enable")}
              onPress={() =>
                setStatus.mutate({ id: user.id, status: user.status === "active" ? "disabled" : "active" })
              }
            />
          ) : null}
        </View>
      ))}

      <Heading>{t("staff.add")}</Heading>
      <Field label={t("staff.name")} value={form.name} onChangeText={(name) => setForm({ ...form, name })} />
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
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
      <Button
        label={t("staff.create")}
        onPress={() => create.mutate()}
        disabled={create.isPending || !form.name || !form.email || form.password.length < 8}
      />
    </Screen>
  );
}
