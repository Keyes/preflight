// What the client and the server both use: the shape of the data they exchange, and the maths both sides apply to it.
// Plain TypeScript only: nothing here may import Node, the DOM, Vue or Babylon.

export type * from './catalog.js'
export type * from './rider.js'
export type * from './venue.js'
export { similarityFromPairs, toWorld, type Similarity } from './similarity.js'
