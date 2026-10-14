import { spawn } from "node:child_process";

export function openUrl(url) {
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
