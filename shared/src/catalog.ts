/** One DMX mode of a fixture: its channels in order, each with the name and what it controls ('' when we do not use it). */
export interface CatalogMode {
  name: string
  shortName?: string
  /** how many channels the mode uses, for custom fixtures whose channel list is not known yet */
  channelCount?: number
  channels: [name: string, attribute: string][]
}

/** A fixture from the Open Fixture Library, trimmed to what pre(f)light uses. Built by `npm run import-fixtures`. */
export interface CatalogFixture {
  /** manufacturer key and fixture key, as in the library's own URLs, e.g. "robe/robin-600e-spot" */
  id: string
  manufacturer: string
  manufacturerKey: string
  name: string
  categories: string[]
  /** a moving head or scanner (the others are placed as a fixed beam for now) */
  moving: boolean
  /** beam angle at the narrowest and widest zoom, degrees (full cone) */
  beamAngle?: [number, number]
  /** total pan and tilt travel, degrees */
  panDegrees?: number
  tiltDegrees?: number
  lumens?: number
  /** the library has no lumens for this fixture: estimated from its power */
  lumensEstimated?: boolean
  powerW?: number
  weightKg?: number
  sizeMm?: [number, number, number]
  colorTemperature?: number
  /** attributes some mode controls: pan, tilt, dimmer, red, zoom, focus, gobo, strobe, prism, ... */
  features: string[]
  modes: CatalogMode[]
  /** custom fixtures only: other names a tech rider may use for it */
  aliases?: string[]
  /** custom fixtures only: where the numbers come from and what is still unverified */
  notes?: string
}

export interface CatalogFile {
  source: { name: string; url: string; repository: string; commit: string; license: string }
  importedAt: string
  fixtures: CatalogFixture[]
}
