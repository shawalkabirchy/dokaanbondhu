// Runs once when the server starts (spec 8.1): checks the environment and opens the platform pool, so a missing
// variable stops the start instead of the first request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { serverEnv } = await import("./src/env");
  const { logger, platform } = await import("./src/server/singletons");
  serverEnv();
  platform();
  logger().info("server started");
}
