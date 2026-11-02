import { registerProvider, type ProviderOptions, type VisionProvider, type VisionRequest } from './provider.js'

const API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-opus-5-5'

interface MessageResponse {
  content?: { type: string; text?: string }[]
  error?: { type: string; message: string }
}

class AnthropicVision implements VisionProvider {
  readonly name = 'anthropic'
  readonly model: string
  private readonly apiKey: string

  constructor(options: ProviderOptions) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('No Anthropic API key: set ANTHROPIC_API_KEY, or pass one in the settings')
    this.apiKey = apiKey
    this.model = options.model ?? DEFAULT_MODEL
  }

  async ask({ image, prompt, maxTokens = 8000 }: VisionRequest): Promise<string> {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    })
    const body = (await response.json().catch(() => ({}))) as MessageResponse
    if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${body.error?.message ?? 'no details'}`)
    return (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
  }
}

registerProvider('anthropic', (options) => new AnthropicVision(options))
