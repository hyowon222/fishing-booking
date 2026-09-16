import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Bind to 127.0.0.1 by default so this server is only reachable from inside
// the same container/network namespace. When this API server is deployed as
// its own standalone Render service (no frontend sharing the box), set
// HOST=0.0.0.0 so Render's external traffic can actually reach it.
const host = process.env["HOST"] ?? "127.0.0.1";

app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, host }, "Server listening");
});
