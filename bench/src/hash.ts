import type { MapTreeStore } from '@understory/core'

/** FNV-1a, 32-bit. Not cryptographic; it only has to detect drift. */
function fnv1a(input: string): number {
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
