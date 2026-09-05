declare const NodeIdBrand: unique symbol
declare const OrderKeyBrand: unique symbol

/**
 * An opaque, source-provided, stable identifier for a node (ADR-0004).
 *
 * Branded because `NodeId` and `OrderKey` are both strings, and using one where
 * the other belongs is a real defect that is otherwise invisible to the compiler.
 * See `test/model.test-d.ts` for the assertions that prove the brand bites.
 */
export type NodeId = string & { readonly [NodeIdBrand]: true }

/**
 * An opaque comparable key describing a node's position among its siblings.
 *
 * The engine never sorts by it (ADR-0004: sorting a partially loaded sibling set
 * produces a locally consistent, globally wrong order). It exists so that a node
 * arriving later can be placed correctly within an already-loaded range, which is
 * M2 work. In M0 it is carried and validated, not used for ordering.
 */
export type OrderKey = string & { readonly [OrderKeyBrand]: true }

export const nodeId = (value: string): NodeId => value as NodeId
export const orderKey = (value: string): OrderKey => value as OrderKey

export const compareOrderKeys = (a: OrderKey, b: OrderKey): number => (a < b ? -1 : a > b ? 1 : 0)
