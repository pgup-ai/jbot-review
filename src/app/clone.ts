import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function clonePr(
  cloneUrl: string,
  headRef: string,
  baseRef: string,
  token: string,
): { dir: string; cleanup: () => void } {
  const authUrl = cloneUrl.replace("https://", `https://x-access-token:${token}@`);
  const dir = mkdtempSync(join(tmpdir(), "jbot-"));
  try {
    execSync(`git clone --depth=50 "${authUrl}" --branch "${headRef}" "${dir}"`, { stdio: "pipe" });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to clone PR branch: ${(error as Error).message}`);
  }

  try {
    execSync(`git fetch origin "${baseRef}":"${baseRef}" --depth=50`, {
      cwd: dir,
      stdio: "pipe",
    });
  } catch {
    // base ref may not be fetchable; non-fatal.
  }

  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
