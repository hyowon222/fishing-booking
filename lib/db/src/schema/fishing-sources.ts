import { createInsertSchema } from "drizzle-zod";
import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const fishingSourcesTable = pgTable("fishing_sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  port: text("port").notNull(),
  sourceUrl: text("source_url").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFishingSourceSchema = createInsertSchema(fishingSourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFishingSource = z.infer<typeof insertFishingSourceSchema>;
export type FishingSource = typeof fishingSourcesTable.$inferSelect;