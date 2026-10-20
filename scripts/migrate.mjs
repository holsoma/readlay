import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

export async function migrate(connection, createSql = neon) {
  const directory = new URL('../db/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No database migrations found.');
  // These checked-in migrations contain simple, idempotent DDL only.
  // Keep them ordered and run them together so existing data is preserved on failure.
  const statements = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), 'utf8');
    statements.push(...source.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim())
      .filter(s => s && !/^(BEGIN|COMMIT)$/i.test(s)));
  }
  const sql = createSql(connection);
  await sql.transaction(statements.map(statement => sql.query(statement)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Run in Vercel's build environment. Database credentials stay on the host.
  const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connection) {
    console.error('Database setup requires DATABASE_URL_UNPOOLED or DATABASE_URL.');
    process.exitCode = 1;
  } else {
    try {
      await migrate(connection);
      console.log('Readlay library tables are ready.');
    } catch {
      // Driver errors can contain connection details. Keep secrets out of build logs.
      console.error('Readlay database setup failed. Check the server connection and migration.');
      process.exitCode = 1;
    }
  }
}
