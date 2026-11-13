/**
 * ============================================================================
 * LOCALHOST TCP FORWARDER FOR THE BROWSER SUITE (support/forward.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Playwright `globalSetup`: listens on the port of `E2E_BASE_URL`
 * (`http://localhost:8080`) inside the Playwright container and pipes every
 * connection to `E2E_UPSTREAM` (`trame-server:8080` on the Compose network).
 * The browser keeps a `localhost` origin, i.e. a secure context that matches
 * `TRAME_PUBLIC_ORIGIN` for the WebSocket Origin check, while the server runs
 * in its own container that the harness can SIGKILL, restart, or stop for a
 * restore without taking the browsers down with it.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `Byte Pipe, No HTTP Awareness`:
 *    - Bytes are copied unchanged both ways, so `Host`, `Origin`, cookies,
 *      `Accept-Encoding` and the WebSocket upgrade reach the server exactly
 *      as the browser sent them.
 * 2. `Fresh Upstream Per Connection`:
 *    - The upstream name is resolved on every connection, so a restarted or
 *      recreated server container is reached at its new address.
 * 3. `Server Down Looks Like A Reset`:
 *    - When the upstream refuses or drops, the browser side is destroyed
 *      too: the page sees a reset connection, the same as a crashed server
 *      behind a reverse proxy, and its reconnect logic takes over.
 * 4. `Opt-In`:
 *    - Without `E2E_UPSTREAM` (a server already listening on localhost) the
 *      setup does nothing.
 * ============================================================================
 */
import { connect, createServer, type Socket } from 'node:net';

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const upstream = process.env.E2E_UPSTREAM;
  if (!upstream) return;
  const [host, port] = upstream.split(':');
  const listenPort = Number(new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').port || 80);
  const open = new Set<Socket>();
  const server = createServer((client) => {
    const target = connect(Number(port), host);
    const close = () => {
      client.destroy();
      target.destroy();
    };
    for (const socket of [client, target]) {
      open.add(socket);
      socket.on('error', close);
      socket.on('close', () => {
        open.delete(socket);
        close();
      });
    }
    client.pipe(target).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', resolve);
  });
  return async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
