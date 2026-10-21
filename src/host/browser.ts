import { spawn } from "node:child_process";

export function browserCommand(
  url: string,
  platform = process.platform,
): [string, string[]] {
  const parsed = new URL(url);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    /[\x00-\x1f\x7f]/.test(url)
  )
    throw Error("授权链接必须是 HTTP 或 HTTPS 地址");
  // Pass the URL as one argument without a shell, preserving OAuth query parameters.
  return platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : [platform === "darwin" ? "open" : "xdg-open", [url]];
}

export async function openSystemBrowser(url: string): Promise<void> {
  const [command, args] = browserCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("浏览器启动失败")),
    );
  });
}

export async function authorizationLink(
  loginUrl: string,
  open = openSystemBrowser,
): Promise<{ loginUrl: string; browserOpened: boolean }> {
  try {
    browserCommand(loginUrl);
    await open(loginUrl);
    return { loginUrl, browserOpened: true };
  } catch {
    // Keep the same pending authorization session available for manual opening.
    return { loginUrl, browserOpened: false };
  }
}
