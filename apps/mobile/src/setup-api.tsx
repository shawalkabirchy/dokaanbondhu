import type {
  CapabilityView,
  ConnectionCreate,
  ConnectionTest,
  ConnectionView,
  DiscoverResult,
  FeaturesView,
  HostFeatures,
} from "@dokaanbondhu/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch, Text, View } from "react-native";
import { api, errorText } from "./lib/api";
import { useDeviceSettings } from "./lib/settings-store";
import { Button, Chips, colors, Field, Heading, Note, styles } from "./ui";

// Setup, the API half (spec 15.2, 11.8, 11.12, 11.13; D134): the shop app's API connection, its actions found in its
// OpenAPI description (switched on only once the sandbox check has verified them and their fields are confirmed), and
// the shop app's feature list. Owner only; shown below the database half.

function useErrorText() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  return (error: unknown) => errorText(error, language, t("common.error"));
}

function testNote(
  test: ConnectionTest,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  if (!test.ok) return `${t("setup.test_failed")} ${test.error ?? ""}`.trim();
  return t("setup.api_test_ok", {
    count: test.operations ?? 0,
    key: t(`setup.api_key_${test.key ?? "not_checked"}`),
  });
}

function ApiConnectionForm({ onSaved }: { onSaved: (test: ConnectionTest) => void }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const [form, setForm] = useState({
    base_url: "",
    auth_type: "api_key" as "api_key" | "bearer",
    auth_header: "",
    secret: "",
  });
  const save = useMutation({
    mutationFn: async () => {
      const body: ConnectionCreate = {
        kind: "api",
        base_url: form.base_url.trim(),
        auth_type: form.auth_type,
        secret: form.secret,
        ...(form.auth_type === "api_key" && form.auth_header.trim()
          ? { auth_header: form.auth_header.trim() }
          : {}),
      };
      const created = await api<{ connection: ConnectionView }>("/setup/connections", {
        method: "POST",
        body,
      });
      // Tested at once: the description is read and the key checked with a harmless read (D134).
      return api<ConnectionTest>(`/setup/connections/${created.connection.id}/test`, { method: "POST" });
    },
    onSuccess: onSaved,
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  return (
    <View style={{ gap: 12 }}>
      <Field
        label={t("setup.api_base_url")}
        value={form.base_url}
        onChangeText={set("base_url")}
        autoCapitalize="none"
        keyboardType="url"
        placeholder="https://"
      />
      <Note>{t("setup.api_auth")}</Note>
      <Chips
        value={form.auth_type}
        options={[
          { value: "api_key", label: t("setup.api_auth_key") },
          { value: "bearer", label: t("setup.api_auth_bearer") },
        ]}
        onChange={set("auth_type")}
      />
      {form.auth_type === "api_key" ? (
        <>
          <Field
            label={t("setup.api_header")}
            value={form.auth_header}
            onChangeText={set("auth_header")}
            autoCapitalize="none"
          />
          <Note>{t("setup.api_header_hint")}</Note>
        </>
      ) : null}
      <Field label={t("setup.api_secret")} value={form.secret} onChangeText={set("secret")} secureTextEntry />
      {save.isError ? <Note tone="danger">{message(save.error)}</Note> : null}
      <Button
        label={save.isPending ? t("common.loading") : t("setup.save_api")}
        onPress={() => save.mutate()}
        disabled={save.isPending || !form.base_url.trim() || !form.secret}
      />
    </View>
  );
}

function ApiConnectionSummary(props: {
  connection: ConnectionView;
  onTested: (test: ConnectionTest) => void;
}) {
  const { t } = useTranslation();
  const message = useErrorText();
  const { connection } = props;
  const test = useMutation({
    mutationFn: () => api<ConnectionTest>(`/setup/connections/${connection.id}/test`, { method: "POST" }),
    onSuccess: props.onTested,
  });
  return (
    <View style={styles.card}>
      <Text style={{ fontSize: 18, fontWeight: "600", color: colors.ink }}>{connection.base_url}</Text>
      <Note>
        {t(connection.auth_type === "bearer" ? "setup.api_auth_bearer" : "setup.api_auth_key")}
        {connection.auth_header ? ` (${connection.auth_header})` : ""}
      </Note>
      <Note tone={connection.status === "active" ? "ok" : connection.status === "error" ? "danger" : "muted"}>
        {t(`setup.status.${connection.status}`)}
      </Note>
      {connection.last_error ? (
        <Note tone="danger">
          {t("setup.test_failed")} {connection.last_error}
        </Note>
      ) : null}
      {test.isError ? <Note tone="danger">{message(test.error)}</Note> : null}
      <Button
        kind="plain"
        label={test.isPending ? t("common.loading") : t("setup.test")}
        onPress={() => test.mutate()}
        disabled={test.isPending}
      />
    </View>
  );
}

/** One action: what it does, whether the sandbox verified it, its fields to confirm, who may use it, on or off. */
function ActionCard({ capability }: { capability: CapabilityView }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ capability: CapabilityView }>(`/setup/capabilities/${capability.id}`, { method: "PATCH", body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["setup", "capabilities"] }),
  });
  const unconfirmed = capability.params.filter((param) => !param.confirmed);
  return (
    <View style={[styles.card, { gap: 8 }]}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: "600", color: colors.ink }}>{capability.name}</Text>
          {capability.description ? <Note>{capability.description}</Note> : null}
        </View>
        <Switch
          value={capability.enabled}
          disabled={change.isPending}
          onValueChange={(enabled) => change.mutate({ enabled })}
          accessibilityLabel={t("setup.action_enabled")}
        />
      </View>
      <Note tone={capability.verified_at ? "ok" : "danger"}>
        {t(capability.verified_at ? "setup.action_verified" : "setup.action_unverified")}
      </Note>
      {unconfirmed.length ? (
        <View style={{ gap: 6 }}>
          <Note>{t("setup.action_fields", { count: unconfirmed.length })}</Note>
          {unconfirmed.map((param) => (
            <Note key={param.path}>
              {param.path}
              {param.semantic_slot ? ` → ${param.semantic_slot}` : ""}
              {param.entity_concept ? ` (${param.entity_concept})` : ""}
            </Note>
          ))}
          <Button
            kind="plain"
            label={t("setup.action_confirm_fields")}
            disabled={change.isPending}
            onPress={() =>
              change.mutate({ params: unconfirmed.map((param) => ({ path: param.path, confirmed: true })) })
            }
          />
        </View>
      ) : null}
      <Chips
        value={capability.required_role}
        options={[
          { value: "staff", label: t("setup.role_staff") },
          { value: "owner", label: t("setup.role_owner") },
        ]}
        onChange={(required_role) => change.mutate({ required_role })}
      />
      {change.isError ? <Note tone="danger">{message(change.error)}</Note> : null}
    </View>
  );
}

function ActionsSection({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["setup", "capabilities", connectionId],
    queryFn: () =>
      api<{ capabilities: CapabilityView[] }>(`/setup/capabilities?connection_id=${connectionId}`),
  });
  const discover = useMutation({
    mutationFn: () =>
      api<DiscoverResult>("/setup/capabilities/discover", {
        method: "POST",
        body: { connection_id: connectionId },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["setup"] }),
  });
  // Undo-only actions are never offered (D52); reads are answered through the database.
  const writes = (list.data?.capabilities ?? []).filter(
    (item) => item.kind === "write" && !item.is_compensation,
  );
  return (
    <View style={{ gap: 12 }}>
      <Button
        kind="plain"
        label={discover.isPending ? t("common.loading") : t("setup.discover")}
        onPress={() => discover.mutate()}
        disabled={discover.isPending}
      />
      {discover.data ? (
        <Note tone="ok">
          {t("setup.discover_done", {
            added: discover.data.added.length,
            changed: discover.data.changed.length,
          })}
        </Note>
      ) : null}
      {discover.isError ? <Note tone="danger">{message(discover.error)}</Note> : null}
      {writes.length === 0 && !list.isLoading ? <Note>{t("setup.actions_none")}</Note> : null}
      {writes.map((capability) => (
        <ActionCard key={capability.id} capability={capability} />
      ))}
    </View>
  );
}

function FeaturesSection({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["setup", "features"],
    queryFn: () => api<FeaturesView>("/setup/features"),
  });
  const mine = view.data?.connections.find((item) => item.connection_id === connectionId);
  const confirm = useMutation({
    mutationFn: (features: HostFeatures) =>
      api("/setup/features", { method: "PUT", body: { connection_id: connectionId, features } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["setup", "features"] }),
  });
  if (!mine)
    return view.isLoading ? <Note>{t("common.loading")}</Note> : <Note>{t("setup.features_none")}</Note>;
  const entries = Object.entries(mine.features);
  return (
    <View style={[styles.card, { gap: 6 }]}>
      {entries.length === 0 ? <Note>{t("setup.features_none")}</Note> : null}
      {entries.map(([key, value]) => (
        <Note key={key}>
          {key}: {Array.isArray(value) ? value.join(", ") : String(value)}
        </Note>
      ))}
      <Note tone={mine.confirmed_at ? "ok" : "muted"}>
        {t(mine.confirmed_at ? "setup.features_confirmed" : "setup.features_detected")}
      </Note>
      {confirm.isError ? <Note tone="danger">{message(confirm.error)}</Note> : null}
      {!mine.confirmed_at ? (
        <Button
          label={confirm.isPending ? t("common.loading") : t("setup.confirm")}
          onPress={() => confirm.mutate(mine.features)}
          disabled={confirm.isPending}
        />
      ) : null}
    </View>
  );
}

/** The API half of setup: its steps, each shown once the one before it works. */
export function ApiSetup({ connections }: { connections: ConnectionView[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [tested, setTested] = useState<ConnectionTest | null>(null);
  const apis = connections.filter(
    (connection) => connection.kind === "api" && connection.status !== "disabled",
  );
  const current = apis.find((connection) => connection.status === "active") ?? apis.at(-1) ?? null;
  const onTested = (test: ConnectionTest) => {
    setTested(test);
    setAdding(false);
    void queryClient.invalidateQueries({ queryKey: ["setup"] });
  };
  return (
    <>
      <Heading>{t("setup.step_api")}</Heading>
      {tested ? <Note tone={tested.ok ? "ok" : "danger"}>{testNote(tested, t)}</Note> : null}
      {current && !adding ? (
        <>
          <ApiConnectionSummary connection={current} onTested={onTested} />
          <Button kind="plain" label={t("setup.new_connection")} onPress={() => setAdding(true)} />
        </>
      ) : (
        <ApiConnectionForm onSaved={onTested} />
      )}
      {current?.status === "active" && !adding ? (
        <>
          <Heading>{t("setup.step_actions")}</Heading>
          <ActionsSection connectionId={current.id} />
          <Heading>{t("setup.step_features")}</Heading>
          <FeaturesSection connectionId={current.id} />
        </>
      ) : null}
    </>
  );
}
