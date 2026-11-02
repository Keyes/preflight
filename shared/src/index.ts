// What the client and the server both use: the shape of the data they exchange (as schemas the server checks requests
// against), and the maths both sides apply to it. Plain TypeScript and zod only: nothing here may import Node, the DOM,
// Vue or Babylon.

export type * from './catalog.js'
export * from './rider.js'
export * from './requests.js'
export * from './venue.js'
export { similarityFromPairs, toWorld, type Similarity } from './similarity.js'
