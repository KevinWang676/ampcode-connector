/** Cross-platform: macOS (open), Linux (xdg-open), Windows (start). */
export async function open(url: string): Promise<boolean> {
  let cmd: string[];
  if (process.platform === "darwin") {
    cmd = ["open", url];
  } else if (process.platform === "linux") {
    cmd = ["xdg-open", url];
  } else if (process.platform === "win32") {
    // cmd.exe interprets `&` (and a few other chars) as command separators when
    // they appear in unquoted arguments. OAuth URLs always contain `&`, so we
    // caret-escape cmd metacharacters before passing them through.
    // The empty `""` argument becomes start's window title so the URL itself
    // is treated as the file/URL to open.
    const escaped = url.replace(/[&|<>^()%!"]/g, "^$&");
    cmd = ["cmd", "/c", "start", "", escaped];
  } else {
    return false;
  }

  try {
    const proc = Bun.spawn(cmd);
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
