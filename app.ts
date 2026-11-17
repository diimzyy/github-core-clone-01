// GLASS-FORGE: a GitHub-compatible forge — git smart HTTP (v0 + v2), REST v3, GraphQL v4 and
// MCP in one Node process, no dependency beyond Node built-ins. app.ts builds the server the
// harness scores; main.ts owns the entry <-> env lifecycle.

import type { Server } from 'node:http';
import { createApp as createForgeApp } from './src/http.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createForgeApp();
}
