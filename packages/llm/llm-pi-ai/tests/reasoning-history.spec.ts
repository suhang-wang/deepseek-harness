import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { withoutReasoningHistory } from '../src/adapter.ts'

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// A strict OpenAI-compatible gateway rejects the assistant reasoning field
// pi-ai emits when this history is replayed.
const assistant: AssistantMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'reasoning' },
    { type: 'text', text: 'answer' },
    { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.txt' } },
  ],
  api: 'openai-completions',
  provider: 'enterprise',
  model: 'qwen-local:Qwen3.8-27B',
  usage,
  stopReason: 'toolUse',
  timestamp: 0,
}

const context: Context = {
  messages: [
    { role: 'user', content: 'hello', timestamp: 0 },
    assistant,
  ],
}

describe('withoutReasoningHistory', () => {
  it('removes assistant thinking blocks without mutating the input', () => {
    const result = withoutReasoningHistory(context)
    const filtered = result.messages[1]
    expect(filtered?.role).toBe('assistant')
    if (filtered?.role !== 'assistant') throw new Error('expected an assistant message')
    expect(filtered.content.map(block => block.type)).toEqual(['text', 'toolCall'])
    expect(assistant.content.map(block => block.type)).toEqual(['thinking', 'text', 'toolCall'])
    expect(result.messages[0]).toBe(context.messages[0])
  })
})
