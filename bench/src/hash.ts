import type { MapTreeStore } from '@understory/core'

/** FNV-1a, 32-bit. Not cryptographic; it only has to detect drift. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * A hash of a corpus's structure, used to prove that the same seed produces the
 * same tree on a different machine.
 *
 * Deliberately covers shape and counts but not object identity, so it stays
 * stable across refactors of the record type while still catching a generator
 * whose output has changed.
 */
export function structureHash(store: MapTreeStore): string {
  const parts: string[] = [`roots:${store.roots.join(',')}`]
  for (const [id, node] of store.entries()) {
    parts.push(
      `${id}|${node.parentId ?? '-'}|${node.orderKey}|${node.childCount.kind}:${node.childCount.value}|${
        node.childIds === undefined ? 'u' : node.childIds.length
      }`,
    )
  }
  return fnv1a(parts.join('\n')).toString(16).padStart(8, '0')
}

/**
 * A digest of an M1 state fingerprint.
 *
 * The fingerprint itself is a full description of coverage and rows, which is what
 * makes it useful for reproducing a divergence and useless for storing: at a
 * million nodes one run produced a single fingerprint of 1.08 MB, and a matrix of
 * 756 runs wrote a 37 MB result file whose content was almost entirely these
 * strings. Nothing ever reads a fingerprint; the only question asked of it is
 * whether two runs agree, and a digest answers that in eight characters.
 */
export const fingerprintDigest = (fingerprint: string): string =>
  `${fnv1a(fingerprint).toString(16).padStart(8, '0')}:${fingerprint.length}`
