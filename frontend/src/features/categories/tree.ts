import type { Category } from '@/api/types'

export interface CategoryNode {
  category: Category
  children: CategoryNode[]
}

export interface FlatCategory {
  category: Category
  /** 0 for top-level categories. */
  depth: number
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

/**
 * Builds the forest from the flat list. Siblings are sorted by name. A category
 * whose parent is missing from the list is shown at the top level.
 */
export function buildTree(categories: readonly Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>()
  for (const category of categories) nodes.set(category.id, { category, children: [] })

  const roots: CategoryNode[] = []
  for (const node of nodes.values()) {
    const parent = node.category.parent_id ? nodes.get(node.category.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sort = (list: CategoryNode[]) => {
    list.sort((a, b) => collator.compare(a.category.name, b.category.name))
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}

/** Depth-first list of the forest; `skip` prunes a node together with its subtree. */
export function flattenTree(
  forest: readonly CategoryNode[],
  skip: (category: Category) => boolean = () => false,
): FlatCategory[] {
  const out: FlatCategory[] = []
  const walk = (nodes: readonly CategoryNode[], depth: number) => {
    for (const node of nodes) {
      if (skip(node.category)) continue
      out.push({ category: node.category, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(forest, 0)
  return out
}

/** The node with the given id, searching the whole forest. */
export function findNode(forest: readonly CategoryNode[], id: string): CategoryNode | undefined {
  for (const node of forest) {
    if (node.category.id === id) return node
    const found = findNode(node.children, id)
    if (found) return found
  }
  return undefined
}

/** Number of categories below the node (not counting the node itself). */
export function countDescendants(node: CategoryNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0)
}

/**
 * Categories that can become the parent of `movingId`: not archived, and not
 * the category itself or anything in its subtree. Pass null when creating.
 */
export function parentOptions(
  forest: readonly CategoryNode[],
  movingId: string | null,
): FlatCategory[] {
  return flattenTree(forest, (c) => c.archived_at !== null || c.id === movingId)
}
