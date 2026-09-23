import { createApp } from "./app";
import { resolve } from "path";

const contentDir = resolve(process.cwd(), "content");
const port = Number(process.env.EDITOR_PORT ?? 1416);

const { server } = createApp({ contentDir });
server.listen(port, "127.0.0.1", () => {
  console.log(`Editor API listening on http://127.0.0.1:${port} (content: ${contentDir})`);
});
