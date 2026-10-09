import { createServer } from "node:net";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Could not allocate port"));
        return;
      }
      const port = addr.port;
      server.close(err => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}
