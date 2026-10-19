import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
/** Bind an actual ephemeral HTTP endpoint with cleanup owned by its test. */
export async function httpFixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}
