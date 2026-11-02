import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { HttpError, sendJson } from '../http.js'
import type { Route } from '../router.js'
import { detectModelFormat, HEAD_BYTES } from '../services/model.js'
import { installModel, reconvertModel, uploadPath, type ModelOutcome } from '../services/modelUpload.js'
import { glbPath } from '../services/venues.js'
import { receiveFile, type UploadRules } from '../upload.js'
import { venueOf } from './venues.js'

/** A model upload: SketchUp or glTF, at most 500 MB. */
const MODEL_UPLOAD: UploadRules = {
  maxBytes: 500 * 1024 * 1024,
  tooLarge: 'file too large',
  headBytes: HEAD_BYTES,
  checkHead: (head) => (detectModelFormat(head) ? null : 'not a SketchUp (.skp) or glTF (.glb, .gltf) file'),
}

/** 200 with the venue, or 422 when the model could not be used: with the venue when it changed (the client shows its error), else the reason. */
function sendOutcome(res: ServerResponse, outcome: ModelOutcome) {
  if ('error' in outcome) sendJson(res, 422, outcome.venue ?? { error: outcome.error })
  else sendJson(res, 200, outcome.venue)
}

/** A venue's 3D model: uploading it (raw body), converting it again, and fetching the GLB the viewer loads. */
export const modelRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/venues/:id/model',
    handler: async ({ req, res, params }) => {
      const venue = await venueOf(params.id)
      const upload = uploadPath(venue.id)
      const { hash, head } = await receiveFile(req, upload, MODEL_UPLOAD)
      const format = detectModelFormat(head)! // receiveFile refuses a file whose format is not known
      sendOutcome(res, await installModel(venue, upload, { hash, format }))
    },
  },
  {
    method: 'POST',
    path: '/api/venues/:id/reconvert',
    handler: async ({ res, params }) => {
      const venue = await venueOf(params.id)
      if (venue.status !== 'ready') throw new HttpError(409, 'the venue has no model to convert')
      if (venue.modelFormat === 'glb') throw new HttpError(409, 'the model was uploaded as glTF, so there is nothing to convert')
      sendOutcome(res, await reconvertModel(venue))
    },
  },
  {
    method: 'GET',
    path: '/api/venues/:id/model.glb',
    handler: async ({ res, params }) => {
      const { id } = await venueOf(params.id)
      const info = await stat(glbPath(id)).catch(() => null)
      if (!info) throw new HttpError(404, 'no model yet')
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': info.size,
        // The client appends ?v=<modelHash>, so a given URL never changes.
        'cache-control': 'public, max-age=31536000, immutable',
      })
      createReadStream(glbPath(id)).pipe(res)
    },
  },
]
