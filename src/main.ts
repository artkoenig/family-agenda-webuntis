/** Runs the WebUntis Source as an HTTP plugin on PORT (8080 by default), as its image does. */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { createWebUntisPlugin } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
await servePlugin(createWebUntisPlugin(), { port });
console.log(`WebUntis Source plugin listening on port ${port}`);
