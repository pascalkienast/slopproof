import { connectDatabase, migrateDatabase } from "@slopproof/db";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const connection = connectDatabase(connectionString);
try {
  await migrateDatabase(connection.pool);
  process.stdout.write("Database migrations applied.\n");
} finally {
  await connection.close();
}
