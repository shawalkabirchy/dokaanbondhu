import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, updatedAt } from "./columns";
import { USER_ROLES, USER_STATUSES } from "./enums";

// Shops and their logins (spec 7.2). shops.owner_user_id points at users with a deferrable foreign key, which the
// custom migration adds, because Drizzle cannot declare one and the two tables point at each other.

export interface ShopSettings {
  staff_price_override?: boolean; // default false
  external_providers_allowed?: boolean; // default false
  voice?: string; // default "aditi"
  default_language?: "bn" | "en"; // default "bn"
  evaluation_consent?: boolean; // default false; admin CLI only (D41)
}

export const shops = pgTable("shops", {
  id: id(),
  name: text("name").notNull(),
  marketArea: text("market_area"),
  ownerUserId: uuid("owner_user_id"),
  settings: jsonb("settings")
    .$type<ShopSettings>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    authUserId: uuid("auth_user_id").notNull().unique(), // no FK to auth.users
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    role: text("role").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("users_role_check", oneOf(t.role, USER_ROLES)),
    check("users_status_check", oneOf(t.status, USER_STATUSES)),
    index("users_shop_id_idx").on(t.shopId),
  ],
);
