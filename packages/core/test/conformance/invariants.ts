import {
  approximate,
  rowKey,
  type NodeId,
  type Projection,
  type Row,
  type TreeStore,
} from '../../src/index.js'

/**
 * Structural invariants that hold for ANY correct projection, checked without
 * consulting the oracle.
 *
 * This half of the suite exists because a purely differential suite only proves
 * that two implementations agree, which is worthless if the oracle is wrong.
 * These properties are derived from the definition of the index space itself,
 * so they can catch a defect that both implementations share.
 *
 * Each returns a violation string naming the invariant, so fault injection can
 * report which property caught which fault rather than just "something failed".
 */
export type Violation = string

/** Independent second computation of the expected row count, iterative rather
 * than recursive, deliberately written to share no code with either projection. */
function expectedLength(store: TreeStore, expanded: ReadonlySet<NodeId>): number {
  let total = 0
  const stack: NodeId[] = [...store.roots].reverse()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const node = store.get(id)
    if (node === undefined) throw new Error(`store is missing node ${id}`)
    total += 1
    if (!expanded.has(id)) continue
    if (node.childIds === undefined) {
      total += approximate(node.childCount)
    } else {
      for (let i = node.childIds.length - 1; i >= 0; i--) {
        const child = node.childIds[i]
        if (child !== undefined) stack.push(child)
      }
    }
  }
  return total
}

export function checkInvariants(projection: Projection, store: TreeStore): Violation[] {
  const violations: Violation[] = []
  const count = projection.count()
  const length = approximate(count)
  const rows = projection.slice(0, length)
  const expanded = projection.expandedIds()

  // I1  the reported count matches how many rows can actually be enumerated
  if (rows.length !== length) {
    violations.push(`I1 count-matches-enumeration: count=${length} enumerated=${rows.length}`)
  }

  // I14 an independently computed length agrees. This is the invariant that can
  //     catch a defect shared by every projection implementation.
  const independent = expectedLength(store, expanded)
  if (independent !== length) {
    violations.push(`I14 independent-length: expected=${independent} reported=${length}`)
  }

  // I2  each row knows its own position
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row !== undefined && row.index !== i) {
      violations.push(`I2 index-field: row at position ${i} reports index ${row.index}`)
      break
    }
  }

  // I3/I4 identity: no two rows share a key, no node appears twice
  const keys = new Set<string>()
  const nodeIds = new Set<NodeId>()
  for (const row of rows) {
    const key = rowKey(row)
    if (keys.has(key)) {
      violations.push(`I3 unique-row-keys: duplicate ${key}`)
      break
    }
    keys.add(key)
    if (row.kind === 'node') {
      if (nodeIds.has(row.id)) {
        violations.push(`I4 unique-node-ids: duplicate ${row.id}`)
        break
      }
      nodeIds.add(row.id)
    }
  }

  // I5/I6/I13 shape: depth grows by at most one, and a row's parent is the node
  //           that owns the depth immediately above it
  const ancestors: NodeId[] = []
  let previousDepth = -1
  for (const row of rows) {
    if (row.depth > previousDepth + 1) {
      violations.push(`I13 depth-monotone: jumped from ${previousDepth} to ${row.depth}`)
      break
    }
    ancestors.length = row.depth
    const expectedParent = row.depth === 0 ? null : (ancestors[row.depth - 1] ?? null)
    const actualParent = row.kind === 'node' ? row.parentId : row.parentId
    if (row.depth === 0 && row.kind === 'node' && row.parentId !== null) {
      violations.push(`I5 root-depth-zero: ${row.id} at depth 0 has parent ${row.parentId}`)
      break
    }
    if (row.depth > 0 && actualParent !== expectedParent) {
      violations.push(
        `I6 parent-precedes-child: row ${rowKey(row)} at depth ${row.depth} claims parent ${actualParent}, preceded by ${expectedParent}`,
      )
      break
    }
    if (row.kind === 'node') ancestors[row.depth] = row.id
    previousDepth = row.depth
  }

  // I7 a collapsed node contributes exactly one row
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === undefined || row.kind !== 'node') continue
    if (expanded.has(row.id)) continue
    const next = rows[i + 1]
    if (next !== undefined && next.depth > row.depth) {
      violations.push(`I7 collapsed-emits-one: ${row.id} is collapsed but is followed by a child`)
      break
    }
  }

  // I8 the two accessors agree
  for (let i = 0; i < rows.length; i++) {
    const viaResolve = projection.resolve(i)
    const viaSlice = rows[i]
    if (
      viaResolve === undefined ||
      viaSlice === undefined ||
      rowKey(viaResolve) !== rowKey(viaSlice)
    ) {
      violations.push(`I8 resolve-matches-slice: disagreement at index ${i}`)
      break
    }
  }

  // I9 out of range is undefined, not a wrapped or clamped row
  if (projection.resolve(-1) !== undefined)
    violations.push('I9 out-of-range: resolve(-1) returned a row')
  if (projection.resolve(length) !== undefined) {
    violations.push(`I9 out-of-range: resolve(${length}) returned a row`)
  }

  // I10 slice clamps rather than doing anything clever with negatives
  const clamped = projection.slice(-5, 3)
  const plain = projection.slice(0, 3)
  if (clamped.length !== plain.length) {
    violations.push('I10 slice-clamping: negative start did not clamp to zero')
  }
  if (projection.slice(3, 1).length !== 0) {
    violations.push('I10 slice-clamping: inverted range was not empty')
  }

  // I11 the count's confidence reflects whether any row is a guess
  const hasPlaceholder = rows.some((row) => row.kind === 'placeholder')
  const expectedKind = hasPlaceholder ? 'estimated' : 'exact'
  if (count.kind !== expectedKind) {
    violations.push(`I11 count-kind: placeholders=${hasPlaceholder} but kind=${count.kind}`)
  }

  // I12 placeholders under one parent are a contiguous run of slots from zero
  const slotsByParent = new Map<NodeId, number[]>()
  for (const row of rows) {
    if (row.kind !== 'placeholder') continue
    const list = slotsByParent.get(row.parentId) ?? []
    list.push(row.slot)
    slotsByParent.set(row.parentId, list)
  }
  for (const [parent, slots] of slotsByParent) {
    const wrong = slots.some((slot, i) => slot !== i)
    if (wrong) {
      violations.push(`I12 placeholder-slots: ${parent} has slots ${slots.slice(0, 6).join(',')}`)
      break
    }
  }

  // I15 sibling order matches the source. Reordering produces a perfectly
  //     well-formed tree, so no other structural invariant can see it; without
  //     this one, a reordering defect is visible only by differential
  //     comparison, and therefore invisible when checking the oracle itself.
  const seenChildren = new Map<NodeId, NodeId[]>()
  for (const row of rows) {
    if (row.kind !== 'node' || row.parentId === null) continue
    const list = seenChildren.get(row.parentId) ?? []
    list.push(row.id)
    seenChildren.set(row.parentId, list)
  }
  for (const [parentId, observed] of seenChildren) {
    const parent = store.get(parentId)
    if (parent?.childIds === undefined) continue
    const expectedOrder = parent.childIds.join(',')
    if (observed.join(',') !== expectedOrder) {
      violations.push(
        `I15 sibling-order: children of ${parentId} appeared as ${observed.join(',')} but the source lists ${expectedOrder}`,
      )
      break
    }
  }

  return violations
}

/** Convenience for tests that only care whether anything is wrong. */
export const describeRows = (rows: readonly Row[]): string =>
  rows.map((r) => `${' '.repeat(r.depth)}${rowKey(r)}`).join('\n')
