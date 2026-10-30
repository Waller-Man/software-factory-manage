/** Read-only diagnostics. Never outputs .env source, credentials or raw HTTP errors. */
import { readConnectionEnv } from '../lib/env.js';
import { WriteTransport } from '../lib/database/transport.js';
import { CudWriter } from '../lib/database/cud.js';
import { failure } from '../lib/errors.js';
let writer;
try {
  const configured = process.argv[2] ?? '.env'; writer = new CudWriter(new WriteTransport(await readConnectionEnv(configured)));
  await writer.verifySchema(AbortSignal.timeout(10000));
  console.log(JSON.stringify({ ok: true, connection: 'reachable', schema: 'compatible', databaseWrites: 0 }));
} catch (error) { console.log(JSON.stringify({ ok: false, error: failure(error), databaseWrites: 0 })); process.exitCode = 1; }
finally { writer?.dispose(); }
