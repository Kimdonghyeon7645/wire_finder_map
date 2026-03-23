import Database from "better-sqlite3";
import path from "path";

// 서버 프로세스에 단일 인스턴스 유지 (Hot Reload 대응)
const globalDb = global as typeof global & { __db?: Database.Database };

if (!globalDb.__db) {
  globalDb.__db = new Database(
    path.join(process.cwd(), "data/parcel.db"),
    { readonly: true }
  );
}

export default globalDb.__db as Database.Database;
