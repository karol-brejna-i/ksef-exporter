import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { categories } from "./schema.js";

export interface Category {
  id: number;
  name: string;
}

export async function createCategory(db: Db, name: string): Promise<Category> {
  const [row] = await db.insert(categories).values({ name }).returning();
  if (!row) {
    throw new Error("Failed to create category: no row returned");
  }
  return row;
}

export async function getCategoryByName(db: Db, name: string): Promise<Category | undefined> {
  return db.query.categories.findFirst({ where: eq(categories.name, name) });
}

export async function getCategoryById(db: Db, id: number): Promise<Category | undefined> {
  return db.query.categories.findFirst({ where: eq(categories.id, id) });
}

export async function listCategories(db: Db): Promise<Category[]> {
  return db.select().from(categories).all();
}
