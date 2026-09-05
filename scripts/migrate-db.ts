import { loadMigrationConfig } from "@understandproof/config";
import { connectDatabase, migrateDatabase } from "@understandproof/db";

const config = loadMigrationConfig();

const connection = connectDatabase(config.DATABASE_URL);
try {
  await migrateDatabase(connection.pool);
  process.stdout.write("Database migrations applied.\n");
} finally {
  await connection.close();
}
