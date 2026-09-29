import type {
  CatalogSyncResult,
  ConnectionCreate,
  ConnectionTest,
  ConnectionView,
  EntityView,
  ReportsView,
  SchemaView,
  WordsView,
} from "@dokaanbondhu/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { api, errorText } from "../../../src/lib/api";
import { takaText } from "../../../src/lib/money";
import { useMe } from "../../../src/lib/session";
import { useDeviceSettings } from "../../../src/lib/settings-store";
import { Button, Chips, colors, Field, Heading, Note, Screen, styles } from "../../../src/ui";

// Setup, the database half (spec 15.2, 11.3): the connection, the schema map review with sample values as they will be
// spoken, the catalog sync, the stock-value formula, and the words the assistant learned (D102). Owner only.

type Language = "bn" | "en";

function useErrorText() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  return (error: unknown) => errorText(error, language, t("common.error"));
}

function ConnectionForm({ onSaved }: { onSaved: (test: ConnectionTest) => void }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const [form, setForm] = useState({
    dialect: "postgres" as "postgres" | "mysql",
    host: "",
    port: "",
    database: "",
    username: "",
    password: "",
    ssl_mode: "verify-full" as "verify-full" | "require" | "disable",
    ssl_ca: "",
  });
  const save = useMutation({
    mutationFn: async () => {
      const body: ConnectionCreate = {
        kind: "db",
        dialect: form.dialect,
        host: form.host.trim(),
        database: form.database.trim(),
        username: form.username.trim(),
        password: form.password,
        ssl_mode: form.ssl_mode,
        ...(form.port.trim() ? { port: Number(form.port.trim()) } : {}),
        ...(form.ssl_ca.trim() ? { ssl_ca: form.ssl_ca.trim() } : {}),
      };
      const created = await api<{ connection: ConnectionView }>("/setup/connections", {
        method: "POST",
        body,
      });
      // Tested at once, so the owner sees in one step whether the details work.
      return api<ConnectionTest>(`/setup/connections/${created.connection.id}/test`, { method: "POST" });
    },
    onSuccess: onSaved,
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const ready = form.host.trim() && form.database.trim() && form.username.trim() && form.password;
  return (
    <View style={{ gap: 12 }}>
      <Note>{t("setup.dialect")}</Note>
      <Chips
        value={form.dialect}
        options={[
          { value: "postgres", label: "PostgreSQL" },
          { value: "mysql", label: "MySQL" },
        ]}
        onChange={set("dialect")}
      />
      <Field label={t("setup.host")} value={form.host} onChangeText={set("host")} autoCapitalize="none" />
      <Field label={t("setup.port")} value={form.port} onChangeText={set("port")} keyboardType="number-pad" />
      <Field
        label={t("setup.database")}
        value={form.database}
        onChangeText={set("database")}
        autoCapitalize="none"
      />
      <Field
        label={t("setup.username")}
        value={form.username}
        onChangeText={set("username")}
        autoCapitalize="none"
      />
      <Field
        label={t("setup.password")}
        value={form.password}
        onChangeText={set("password")}
        secureTextEntry
      />
      <Note>{t("setup.ssl_mode")}</Note>
      <Chips
        value={form.ssl_mode}
        options={[
          { value: "verify-full", label: t("setup.ssl_verify") },
          { value: "require", label: t("setup.ssl_require") },
          { value: "disable", label: t("setup.ssl_disable") },
        ]}
        onChange={set("ssl_mode")}
      />
      {form.ssl_mode === "require" ? <Note tone="danger">{t("setup.ssl_require_warn")}</Note> : null}
      <Field
        label={t("setup.ssl_ca")}
        value={form.ssl_ca}
        onChangeText={set("ssl_ca")}
        autoCapitalize="none"
        multiline
        style={[styles.input, { minHeight: 110, textAlignVertical: "top", fontSize: 13 }]}
      />
      {save.isError ? <Note tone="danger">{message(save.error)}</Note> : null}
      <Button
        label={save.isPending ? t("common.loading") : t("setup.save_connection")}
        onPress={() => save.mutate()}
        disabled={save.isPending || !ready}
      />
    </View>
  );
}

function ConnectionSummary(props: { connection: ConnectionView; onTested: (test: ConnectionTest) => void }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const { connection } = props;
  const test = useMutation({
    mutationFn: () => api<ConnectionTest>(`/setup/connections/${connection.id}/test`, { method: "POST" }),
    onSuccess: props.onTested,
  });
  return (
    <View style={styles.card}>
      <Text style={{ fontSize: 18, fontWeight: "600", color: colors.ink }}>
        {connection.username}@{connection.host}/{connection.database}
      </Text>
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

function filterText(filter: EntityView["row_filters"][number]): string {
  const value = filter.value === undefined ? "" : String(filter.value);
  const column = `${filter.table}.${filter.column}`;
  if (filter.op === "is_null") return `${column} = NULL`;
  if (filter.op === "is_true") return `${column} = true`;
  return `${column} ${filter.op === "eq" ? "=" : "≠"} ${value}`;
}

function EntityCard(props: { entity: EntityView; onSchema: (schema: SchemaView) => void }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const { entity } = props;
  const confirm = useMutation({
    mutationFn: (scales?: Record<string, number>) =>
      api<{ schema: SchemaView }>(`/setup/schema/${entity.id}`, {
        method: "PUT",
        body: scales
          ? {
              entity: {
                host_table: entity.host_table,
                joins: entity.joins.map((join) => ({ table: join.table, on: join.on })),
                row_filters: entity.row_filters,
                fields: entity.fields.map((field) => ({
                  concept_field: field.concept_field,
                  host_table: field.host_table,
                  host_column: field.host_column,
                  value_scale: scales[field.concept_field] ?? field.value_scale,
                })),
              },
            }
          : {},
      }),
    onSuccess: (data) => props.onSchema(data.schema),
  });
  return (
    <View style={styles.card}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}>
        {t(`setup.concepts.${entity.concept}`, { defaultValue: entity.concept })} ({entity.host_table})
      </Text>
      <Note tone={entity.confirmed ? "ok" : "muted"}>
        {t(entity.confirmed ? "setup.confirmed" : "setup.not_confirmed")}
      </Note>
      {entity.fields.map((field) => (
        <View key={field.concept_field} style={{ gap: 4 }}>
          <Text style={{ fontSize: 15, color: colors.muted }}>
            {field.concept_field} ← {field.host_table}.{field.host_column}
          </Text>
          {/* Keys and links are shown by column only: their sample values mean nothing to an owner. */}
          {field.samples.length && field.kind !== "id" && field.kind !== "ref" ? (
            <Text style={{ fontSize: 17, color: colors.ink }}>{field.samples.join("  ·  ")}</Text>
          ) : null}
          {/* Money: the first sample read both ways; the owner picks the price that is right (the value scale). */}
          {field.kind === "money" && field.readings?.["1"] && field.readings["100"] ? (
            <>
              <Note>{t("setup.which_price")}</Note>
              <Chips
                value={String(field.value_scale)}
                options={[
                  { value: "100", label: field.readings["100"] },
                  { value: "1", label: field.readings["1"] },
                ]}
                onChange={(scale) => confirm.mutate({ [field.concept_field]: Number(scale) })}
              />
            </>
          ) : null}
        </View>
      ))}
      {entity.row_filters.length ? (
        <Note>
          {t("setup.filters")}: {entity.row_filters.map(filterText).join("; ")}
        </Note>
      ) : null}
      {confirm.isError ? <Note tone="danger">{message(confirm.error)}</Note> : null}
      {!entity.confirmed ? (
        <Button
          label={confirm.isPending ? t("common.loading") : t("setup.confirm")}
          onPress={() => confirm.mutate(undefined)}
          disabled={confirm.isPending}
        />
      ) : null}
    </View>
  );
}

function SchemaSection({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const queryClient = useQueryClient();
  const key = ["setup", "schema", connectionId];
  const schema = useQuery({
    queryKey: key,
    queryFn: () => api<{ schema: SchemaView }>(`/setup/schema?connection_id=${connectionId}`),
  });
  const setSchema = (next: SchemaView) => {
    queryClient.setQueryData(key, { schema: next });
    void queryClient.invalidateQueries({ queryKey: ["setup", "reports", connectionId] });
  };
  const propose = useMutation({
    mutationFn: () =>
      api<{ schema: SchemaView }>("/setup/schema/propose", {
        method: "POST",
        body: { connection_id: connectionId },
      }),
    onSuccess: (data) => setSchema(data.schema),
  });
  const view = schema.data?.schema;
  return (
    <View style={{ gap: 12 }}>
      <Note>{t("setup.schema_note")}</Note>
      {propose.isPending ? <Note>{t("setup.proposing")}</Note> : null}
      {propose.isError ? <Note tone="danger">{message(propose.error)}</Note> : null}
      <Button
        kind={view?.entities.length ? "plain" : "primary"}
        label={t("setup.propose")}
        onPress={() => propose.mutate()}
        disabled={propose.isPending}
      />
      {view?.warnings.length ? (
        // What the checks repaired (D90): information for the review, not an error.
        <Note>
          {t("setup.warnings")} {view.warnings.join("; ")}
        </Note>
      ) : null}
      {view?.entities.map((entity) => (
        <EntityCard key={entity.id} entity={entity} onSchema={setSchema} />
      ))}
      {view?.entities.length && view.missing.length ? (
        <Note>
          {t("setup.missing")} {view.missing.map((concept) => t(`setup.concepts.${concept}`)).join(", ")}
        </Note>
      ) : null}
    </View>
  );
}

function CatalogSection({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const sync = useMutation({
    mutationFn: () =>
      api<{ catalog: CatalogSyncResult }>("/setup/catalog/sync", {
        method: "POST",
        body: { connection_id: connectionId },
      }),
  });
  return (
    <View style={{ gap: 12 }}>
      {sync.data ? <Note tone="ok">{t("setup.synced", sync.data.catalog)}</Note> : null}
      {sync.isError ? <Note tone="danger">{message(sync.error)}</Note> : null}
      <Button
        label={sync.isPending ? t("common.loading") : t("setup.sync")}
        onPress={() => sync.mutate()}
        disabled={sync.isPending}
      />
    </View>
  );
}

function ReportsSection({ connectionId, language }: { connectionId: string; language: Language }) {
  const { t } = useTranslation();
  const message = useErrorText();
  const queryClient = useQueryClient();
  const key = ["setup", "reports", connectionId];
  const reports = useQuery({
    queryKey: key,
    queryFn: () => api<{ reports: ReportsView }>(`/setup/reports?connection_id=${connectionId}`),
  });
  const confirm = useMutation({
    mutationFn: () =>
      api<{ reports: ReportsView }>("/setup/reports", {
        method: "PUT",
        body: { connection_id: connectionId, name: "stock_value" },
      }),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
  const stock = reports.data?.reports.stock_value;
  return (
    <View style={{ gap: 12 }}>
      {stock && !stock.available ? <Note>{t("setup.stock_value_na")}</Note> : null}
      {stock?.available ? (
        <Text style={{ fontSize: 18, color: colors.ink }}>
          {t("setup.stock_value_now")}{" "}
          {stock.current_paisa === null ? t("setup.unknown") : takaText(stock.current_paisa, language)}
        </Text>
      ) : null}
      {stock?.confirmed ? <Note tone="ok">{t("setup.stock_value_confirmed")}</Note> : null}
      {confirm.isError ? <Note tone="danger">{message(confirm.error)}</Note> : null}
      {stock?.available && !stock.confirmed ? (
        <Button
          label={t("setup.stock_value_confirm")}
          onPress={() => confirm.mutate()}
          disabled={confirm.isPending}
        />
      ) : null}
      <Note>{t("setup.see_in_app")}</Note>
    </View>
  );
}

/**
 * Words the assistant learned (D102, D105): spellings the listening check found, and car or part names it did not
 * understand at first and then got from an answer (seen twice); the owner adds each (understood straight away next
 * time) or dismisses it. Nothing learned is used before the owner adds it.
 */
function WordsSection() {
  const { t } = useTranslation();
  const message = useErrorText();
  const queryClient = useQueryClient();
  const key = ["setup", "words"];
  const words = useQuery({ queryKey: key, queryFn: () => api<{ words: WordsView }>("/setup/words") });
  const decide = useMutation({
    mutationFn: (input: { id: string; action: "add" | "dismiss" }) =>
      api<{ words: WordsView }>(`/setup/words/${input.id}`, {
        method: "PUT",
        body: { action: input.action },
      }),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
  const view = words.data?.words;
  return (
    <View style={{ gap: 12 }}>
      <Note>{t("setup.words_note")}</Note>
      {view && view.suggestions.length === 0 ? <Note>{t("setup.words_none")}</Note> : null}
      {view?.suggestions.map((word) => (
        <View key={word.id} style={styles.card}>
          <Text style={{ fontSize: 18, color: colors.ink }}>
            “{word.heard}” → {word.value}
          </Text>
          <Note>
            {t(`setup.word_concept.${word.concept}`, { defaultValue: word.concept })} ·{" "}
            {word.origin === "listening"
              ? t("setup.words_from_check")
              : t("setup.words_heard", { count: word.seen })}
          </Note>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button
              label={t("setup.words_add")}
              onPress={() => decide.mutate({ id: word.id, action: "add" })}
              disabled={decide.isPending}
            />
            <Button
              kind="plain"
              label={t("setup.words_dismiss")}
              onPress={() => decide.mutate({ id: word.id, action: "dismiss" })}
              disabled={decide.isPending}
            />
          </View>
        </View>
      ))}
      {decide.isError ? <Note tone="danger">{message(decide.error)}</Note> : null}
      {view ? <Note>{t("setup.words_checked", view.checked)}</Note> : null}
    </View>
  );
}

/** The setup page: its steps, each shown once the one before it works. */
export default function Setup() {
  const { t } = useTranslation();
  const language = useDeviceSettings((state) => state.language);
  const me = useMe();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [tested, setTested] = useState<ConnectionTest | null>(null);
  const connections = useQuery({
    queryKey: ["setup", "connections"],
    queryFn: () => api<{ connections: ConnectionView[] }>("/setup/connections"),
    enabled: me.data?.user.role === "owner",
  });
  const databases = (connections.data?.connections ?? []).filter(
    (connection) => connection.kind === "db" && connection.status !== "disabled",
  );
  const current = databases.find((connection) => connection.status === "active") ?? databases.at(-1) ?? null;
  const onTested = (test: ConnectionTest) => {
    setTested(test);
    setAdding(false);
    void queryClient.invalidateQueries({ queryKey: ["setup"] });
  };

  if (me.data && me.data.user.role !== "owner") return null;
  return (
    <Screen>
      <Heading>{t("setup.step_connection")}</Heading>
      {tested ? (
        <Note tone={tested.ok ? "ok" : "danger"}>
          {tested.ok
            ? t("setup.test_ok", { count: tested.tables ?? 0 })
            : `${t("setup.test_failed")} ${tested.error}`}
        </Note>
      ) : null}
      {current && !adding ? (
        <>
          <ConnectionSummary connection={current} onTested={onTested} />
          <Button kind="plain" label={t("setup.new_connection")} onPress={() => setAdding(true)} />
        </>
      ) : connections.isLoading ? (
        <Note>{t("common.loading")}</Note>
      ) : (
        <ConnectionForm onSaved={onTested} />
      )}

      {current?.status === "active" && !adding ? (
        <>
          <Heading>{t("setup.step_schema")}</Heading>
          <SchemaSection connectionId={current.id} />
          <Heading>{t("setup.step_catalog")}</Heading>
          <CatalogSection connectionId={current.id} />
          <Heading>{t("setup.step_reports")}</Heading>
          <ReportsSection connectionId={current.id} language={language} />
          <Heading>{t("setup.step_words")}</Heading>
          <WordsSection />
        </>
      ) : null}
    </Screen>
  );
}
