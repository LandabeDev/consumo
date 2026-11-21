import { execFile } from "node:child_process";

// Aviso del sistema, sin dependencias. macOS y Linux (notify-send).
// En otros sistemas no avisa y el panel sigue igual.
export function systemNotify(title, body) {
  const done = () => {};
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      execFile("osascript", ["-e", script], done);
      return true;
    }
    if (process.platform === "linux") {
      execFile("notify-send", ["--app-name=Consumo", title, body], done);
      return true;
    }
  } catch {
    // sin avisos del sistema, el panel sigue igual
  }
  return false;
}
