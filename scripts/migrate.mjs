import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

// Run in Vercel's build environment. Database credentials stay on the host.
const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connection) {
  console.error('Database setup requires DATABASE_URL_UNPOOLED or DATABASE_URL.');
  process.exitCode = 1;
} else {
  try {
    const source = await readFile(new URL('../db/migrations/001_library.sql', import.meta.url), 'utf8');
    // This fixed migration contains simple DDL only, without functions or quoted semicolons.
    const statements = source.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim())
      .filter(s => s && !/^(BEGIN|COMMIT)$/i.test(s));
    const sql = neon(connection);
    await sql.transaction(statements.map(statement => sql.query(statement)));
    console.log('Readlay library tables are ready.');
  } catch {
    // Driver errors can contain connection details. Keep secrets out of build logs.
    console.error('Readlay database setup failed. Check the server connection and migration.');
    process.exitCode = 1;
  }
}
