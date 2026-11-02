/**
 * Objects standing on the floor (speaker stacks, trusses, truss legs, stands) cover the spots a plan is placed by. A model is
 * a few meshes with everything of one material in each, so they are found as the connected pieces of those meshes: pieces
 * with a footprint of at most 3.2 m and no higher than 2.5 m over the floor, or thin posts (at most 0.5 m across) up to 4 m.
 *
 * Plain maths on vertex data, so it is tested without a scene.
 */

/** A mesh's triangles as vertex indices: its index buffer, or every three vertices in turn for a mesh drawn without one. */
export function triangleIndices(indices: ArrayLike<number> | null, vertexCount: number): ArrayLike<number> {
  return indices && indices.length ? indices : Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i)
}

/**
 * The triangles to keep when the clutter is taken out of a mesh, and how many go; null when none of the mesh is clutter.
 * `positions` are local x, y, z per vertex, `world` the mesh's world matrix (16 numbers, translation in 12-14).
 */
export function clutterCut(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  world: ArrayLike<number>,
  floorY: number,
): { keep: number[]; hidden: number } | null {
  const m = world
  const count = positions.length / 3
  // vertices at the same place are one (a piece's faces each have their own copies of the corners)
  const first = new Map<string, number>()
  const rep = new Int32Array(count)
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(positions[3 * i] * 1000)}|${Math.round(positions[3 * i + 1] * 1000)}|${Math.round(positions[3 * i + 2] * 1000)}`
    const seen = first.get(key)
    if (seen === undefined) first.set(key, i)
    rep[i] = seen ?? i
  }
  const parent = Int32Array.from({ length: count }, (_, i) => i)
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = find(rep[triangles[t]])
    parent[find(rep[triangles[t + 1]])] = a
    parent[find(rep[triangles[t + 2]])] = a
  }
  // each piece's box in the world, over the vertices its triangles use: x0, x1, top, z0, z1
  const boxes = new Map<number, number[]>()
  for (let t = 0; t < triangles.length - (triangles.length % 3); t++) {
    const i = triangles[t]
    const x = positions[3 * i]
    const y = positions[3 * i + 1]
    const z = positions[3 * i + 2]
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
    const root = find(rep[i])
    const b = boxes.get(root)
    if (!b) boxes.set(root, [wx, wx, wy, wz, wz])
    else {
      b[0] = Math.min(b[0], wx)
      b[1] = Math.max(b[1], wx)
      b[2] = Math.max(b[2], wy)
      b[3] = Math.min(b[3], wz)
      b[4] = Math.max(b[4], wz)
    }
  }
  const hide = new Set<number>()
  for (const [root, b] of boxes) {
    const dx = b[1] - b[0]
    const dz = b[4] - b[3]
    const top = b[2] - floorY
    if ((dx <= 3.2 && dz <= 3.2 && top <= 2.5) || (dx <= 0.5 && dz <= 0.5 && top <= 4)) hide.add(root)
  }
  if (hide.size === 0) return null
  const keep: number[] = []
  let hidden = 0
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    if (hide.has(find(rep[triangles[t]]))) hidden++
    else keep.push(triangles[t], triangles[t + 1], triangles[t + 2])
  }
  return { keep, hidden }
}
