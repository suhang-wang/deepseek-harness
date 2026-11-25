#!/usr/bin/env node
/** Assert that an installed Desktop instance opens the signed company picker with every expected company. */

const port = process.argv[2] ?? '9222'
const expected = (process.argv[3] ?? '').split(',').map(value => value.trim()).filter(Boolean)
const deadline = Date.now() + 180_000

async function pickerTarget() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.find(target => target.type === 'page' && target.url.includes('welcome.html'))
  } catch {
    return undefined
  }
}

function evaluate(target, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(() => { socket.close(); reject(new Error('company picker evaluation timed out')) }, 15_000)
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true },
    }))
    socket.onerror = () => { clearTimeout(timer); reject(new Error('company picker evaluation failed')) }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result?.result?.value)
    }
  })
}

let target
while (target === undefined) {
  if (Date.now() > deadline) throw new Error('company picker window did not appear')
  target = await pickerTarget()
  if (target === undefined) await new Promise(resolve => { setTimeout(resolve, 2_000) })
}

const text = String(await evaluate(target, 'document.body.innerText'))
for (const company of expected) {
  if (!text.includes(company)) throw new Error(`company picker is missing ${company}`)
}
console.log(text)
