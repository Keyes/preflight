/**
 * What the plan reader needs from a vision model: an image and a question in, JSON text out. Each vendor is one small file
 * implementing this (anthropic.ts); the reader never knows which one it talks to.
 */
export interface VisionProvider {
  /** short name, as used on the command line and in settings ("anthropic") */
  readonly name: string
  /** the model asked, for the log */
  readonly model: string
  /**
   * Shows the model one image and returns what it answered. The answer is meant to be a single JSON value; the caller
   * parses it (`parseJsonAnswer`), so a provider may return the text as it came.
   */
  ask(request: VisionRequest): Promise<string>
}

export interface VisionRequest {
  /** the image, PNG */
  image: Buffer
  /** what to look for, and the shape of the answer */
  prompt: string
  /** upper bound for the answer, tokens */
  maxTokens?: number
}

export interface ProviderOptions {
  apiKey?: string
  model?: string
}

type Factory = (options: ProviderOptions) => VisionProvider

const factories = new Map<string, Factory>()

/** Makes a provider available by name. Adding OpenAI or another vendor later is one `registerProvider` call from its own file. */
export function registerProvider(name: string, factory: Factory) {
  factories.set(name, factory)
}

export function providerNames(): string[] {
  return [...factories.keys()]
}

export function createProvider(name: string, options: ProviderOptions = {}): VisionProvider {
  const factory = factories.get(name)
  if (!factory) throw new Error(`Unknown vision provider "${name}". Available: ${providerNames().join(', ') || 'none'}`)
  return factory(options)
}

/** Parses a model's answer as JSON: bare, or inside a ```json fence, or with a sentence before and after it. */
export function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.search(/[[{]/)
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error(`The answer holds no JSON: ${text.slice(0, 120)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}
