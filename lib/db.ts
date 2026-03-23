import path from "node:path";
import Database from "better-sqlite3";

type GlobalWithDb = typeof global & { __db?: Database.Database };

export function getDb(): Database.Database {
  const g = global as GlobalWithDb;
  if (!g.__db) {
    g.__db = new Database(
      path.join(process.cwd(), "data/parcel.db"),
      { readonly: true },
    );
  }
  return g.__db;
}
