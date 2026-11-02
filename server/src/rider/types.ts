/**
 * The rider file: what a venue's tech rider says, in a form pre(f)light can import from. It is the hand-over between reading the
 * rider (a patch table parsed from the PDF's text, a plan read by a vision model or placed by hand) and the import wizard.
 * Everything in it is optional beyond `patch`, so a rider can be imported in stages.
 */

/** One row of the patch table: a light or a set of lights on one DMX address. The newer list wins, so these rows are the truth for name, mode, address and truss. */
export interface RiderPatchRow {
  /** the rider's number for it, as printed ("#201"); the key that ties it to the plan and to a light of ours on a re-import */
  fixId: string
  universe: number
  /** DMX start address, 1-512 */
  address: number
  /** the name in the patch ("Zoom1") */
  name: string
  /** the mode column as printed ("9Ch. SSP, Expolite Tourled MC60 Zoom", "Dim", "Wash") */
  modeRaw: string
  /** the part of `modeRaw` that names a DMX mode ("9Ch. SSP", "4ch.", "Dim"); when the column names a fixture too, that is `typeHint` */
  mode: string
  /** the fixture the mode column names ("Expolite Tourled MC60 Zoom", "Atomic 3000"), if it does; "Dim" rows leave it to the plan and the name */
  typeHint?: string
  /** what the column says in brackets, usually the channel list ("1.dim,2.colwheel,3.shut,4.function") */
  modeNote?: string
  /** channels in the mode when the column says so ("9Ch." is 9); a "Dim" row is 1 */
  channels?: number
  /** the truss as printed ("LX1", "LX3/4") */
  truss: string
}

/** One lamp of the plan. A rider number can be drawn several times (#1 is two lamps on one dimmer); each lamp is then `#1.1`, `#1.2`. */
export interface RiderLamp {
  /** `fixId` for a single lamp, `fixId.n` when the plan shows the number more than once */
  lampId: string
  fixId: string
  /** the number as the plan prints it, when it was matched to a different patch row ("S01" for #501) */
  printed?: string
  /** centre of the symbol on the plan page image, pixels */
  planPx: [number, number]
  /** the way the symbol points, degrees clockwise from "up" on the plan (towards the back wall); absent for a symbol that does not show one */
  facingDeg?: number
  /** the symbol class in the plan's legend ("Zoom PAR", "Mini PAR", "Conv. PAR", "Fresnel", "Profiler", "Strobe", "DWE", "Spot", "Robe LED 150") */
  symbol?: string
  /** the truss whose line the symbol sits on, by the plan's drawing (absent for a stand, a wall or the ceiling); the patch's truss column is what wins when they differ */
  trussOnPlan?: string
  /** 0..1, how sure the reading was (1 for a hand-placed lamp) */
  confidence?: number
}

export interface RiderTruss {
  /** height of the underside in meters */
  underside: number
  /** the truss as a line on the plan page image, pixels */
  planPx?: [[number, number], [number, number]]
}

/** The plan page: the image, its scale and the heights from its title block. */
export interface RiderPlan {
  /** page number in the PDF, 1-based */
  page: number
  /** the image the pixels below refer to */
  image: { width: number; height: number }
  /** printed scale ("1:100") */
  scale?: string
  /** the stage as drawn: width and depth in meters, height in meters, and its corners on the image (front left, front right) */
  stage?: { width: number; depth: number; height: number; planPx?: [[number, number], [number, number]] }
  trusses: Record<string, RiderTruss>
  /** the lowest a light hangs, meters */
  lowestLight?: number
  /** year or date printed on the plan (can be older than the patch) */
  date?: string
}

export interface RiderFile {
  version: 1
  /** the PDF it was read from, by file name */
  source: string
  readAt: string
  patch: {
    /** the date printed on the table, ISO ("2025-08-25"), if there is one */
    date?: string
    title?: string
    rows: RiderPatchRow[]
  }
  plan?: RiderPlan
  lamps?: RiderLamp[]
  /** things the reader noticed in the patch table that need a person's eye (rows it could not read, numbers that appear twice) */
  issues: string[]
  /** the same for the plan, and where plan and patch disagree: set when the plan is read, replaced when it is read again */
  planIssues?: string[]
}
