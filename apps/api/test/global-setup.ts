import { migrateTestDatabase } from '@festpass/db/testing';

// Runs once before all test files: brings the test database up to the latest migration.
export function setup(): void {
  migrateTestDatabase();
}
