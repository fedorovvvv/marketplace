import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Max bytes read off disk and shipped to a bank in one ingest or one batch file. */
export const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;

/**
 * A file we are willing to read and upload: inside the project root (symlinks followed) and under
 * the size cap. Shared by document_ingest_file, memory_retain_batch and the enrich CLI so all three
 * refuse the same files. Server-side secret masking may be off and document text is stored
 * verbatim, so an unbounded path is an exfiltration primitive.
 */
export function assertInsideProject(input: string, projectRoot: string): string {
  const root = realpathSync(resolve(projectRoot));
  let real: string;
  try {
    real = realpathSync(resolve(input));
  } catch (err) {
    throw new Error(`cannot resolve ${input}: ${(err as Error).message}`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    // Refuse rather than truncate: a partial upload of the wrong file is still the wrong file.
    throw new Error(
      `refusing to read ${input}: it resolves to ${real}, which is outside the project root ${root}. ` +
        `Symlinks are followed before this check, so a link pointing out of the project is refused too.`,
    );
  }
  const size = statSync(real).size;
  if (size > MAX_PROJECT_FILE_BYTES) {
    throw new Error(`refusing to read ${real}: ${size} bytes exceeds the ${MAX_PROJECT_FILE_BYTES}-byte cap`);
  }
  return real;
}
