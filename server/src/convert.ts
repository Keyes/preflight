import { execFile } from 'node:child_process'
import { rename, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CONVERTER = fileURLToPath(new URL(`../../converter/build/skp2glb${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))

/**
 * Identifies the built converter (size and modification time of the binary), so models converted by an
 * older build are converted again. Empty when the converter has not been built.
 */
export async function converterVersion(): Promise<string> {
  try {
    const info = await stat(CONVERTER)
    return `${info.size}-${Math.round(info.mtimeMs)}`
  } catch {
    return ''
  }
}

/** Runs the native skp2glb converter; writes the GLB atomically. */
export function convertSkp(skp: string, glb: string): Promise<void> {
  const tmp = `${glb}.tmp`
  return new Promise((resolve, reject) => {
    execFile(CONVERTER, [skp, tmp], { timeout: 120_000, maxBuffer: 1 << 20 }, async (err, _out, stderr) => {
      if (err) {
        await rm(tmp, { force: true })
        const reason = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'the SketchUp converter is not built (see "The SketchUp SDK" in the README), or upload the model as glTF (.glb) instead'
          : stderr.trim() || err.message
        reject(new Error(reason))
        return
      }
      await rename(tmp, glb)
      resolve()
    })
  })
}
