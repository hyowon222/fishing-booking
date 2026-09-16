import { integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { fishingSourcesTable } from "./fishing-sources";

export const fishingSourceVesselsTable = pgTable(
  "fishing_source_vessels",
  {
    id: serial("id").primaryKey(),
    sourceId: integer("source_id")
      .notNull()
      .references(() => fishingSourcesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    departurePort: text("departure_port").notNull().default(""),
    address: text("address").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceNameUnique: unique("fishing_source_vessels_source_name_unique").on(table.sourceId, table.name),
  }),
);

export type FishingSourceVessel = typeof fishingSourceVesselsTable.$inferSelect;