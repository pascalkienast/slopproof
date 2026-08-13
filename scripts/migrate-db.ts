import { loadMigrationConfig } from "@slopproof/config";
import { connectDatabase, migrateDatabase } from "@slopproof/db";

const config = loadMigrationConfig();

const connection = connectDatabase(config.DATABASE_URL);
try {
  await migrateDatabase(connection.pool);
  process.stdout.write("Database migrations applied.\n");
} finally {
  await connection.close();
}
