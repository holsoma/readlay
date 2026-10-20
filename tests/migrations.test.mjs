import assert from "node:assert/strict";
import test from "node:test";
import { migrate } from "../scripts/migrate.mjs";

test("the migration runner includes word progress after creating the existing tables", async () => {
  const transactions = [];
  await migrate("test-only-connection", connection => {
    assert.equal(connection, "test-only-connection");
    return {
      query: statement => ({ statement }),
      transaction: async statements => { transactions.push(statements); },
    };
  });
  assert.equal(transactions.length, 1, "all migrations must share a transaction");
  const statements = transactions[0].map(query => query.statement);
  assert.equal(statements.length, 5);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS readlay_progress/);
  assert.match(statements[4], /^ALTER TABLE readlay_progress\s+ADD COLUMN IF NOT EXISTS char_offset integer NOT NULL DEFAULT 0\s+CHECK \(char_offset >= 0\)$/);
  assert.equal(statements.some(statement => /\b(DROP|DELETE|TRUNCATE)\b/i.test(statement)), false, "existing reading data must remain intact");
  assert.equal(statements.some(statement => /^(BEGIN|COMMIT)$/i.test(statement)), false, "the driver owns the transaction boundary");
});

test("migration failure propagates so a failed schema update cannot be reported as successful", async () => {
  const failure = new Error("test database refused the transaction");
  await assert.rejects(migrate("test-only-connection", () => ({
    query: statement => statement,
    transaction: async () => { throw failure; },
  })), error => error === failure);
});
