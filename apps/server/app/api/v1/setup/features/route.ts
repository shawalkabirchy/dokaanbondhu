import { featuresPutSchema, hostFeaturesSchema, type FeaturesView } from "@dokaanbondhu/contracts";
import { connections } from "@dokaanbondhu/platform-db";
import { and, asc, eq, ne } from "drizzle-orm";
import { readBody, route } from "../../../../../src/server/route";
import { apiConnectionRow } from "../../../../../src/server/setup";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The host feature list (spec 11.13; architecture, host requirements): detected from the OpenAPI document by discover,
// then confirmed or edited by the owner. It belongs to an API connection.

/** GET /setup/features (owner): each API connection's list and when it was confirmed (null: only detected). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ caller }) => {
  const rows = await platform().withShop(caller.shopId, (tx) =>
    tx
      .select()
      .from(connections)
      .where(and(eq(connections.kind, "api"), ne(connections.status, "disabled")))
      .orderBy(asc(connections.createdAt)),
  );
  const view: FeaturesView = {
    connections: rows.map((row) => {
      const features = hostFeaturesSchema.safeParse(row.features);
      return {
        connection_id: row.id,
        label: row.label,
        features: features.success ? features.data : {},
        confirmed_at: row.featuresConfirmedAt?.toISOString() ?? null,
      };
    }),
  };
  return Response.json(view);
});

/** PUT /setup/features (owner): { connection_id, features } confirms the list as given. */
export const PUT = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const body = await readBody(request, featuresPutSchema);
  const row = await apiConnectionRow(caller.shopId, body.connection_id);
  const [saved] = await platform().withShop(caller.shopId, (tx) =>
    tx
      .update(connections)
      .set({ features: body.features, featuresConfirmedAt: new Date() })
      .where(eq(connections.id, row.id))
      .returning(),
  );
  return Response.json({
    connection_id: saved!.id,
    label: saved!.label,
    features: body.features,
    confirmed_at: saved!.featuresConfirmedAt!.toISOString(),
  });
});
