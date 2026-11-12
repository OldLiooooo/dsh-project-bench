// In-process change bus: every successful project write announces a new revision per project root.
// The client receives it over authenticated SSE and re-reads the snapshot; no polling.
import { EventEmitter } from 'node:events'

export function createBus() {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)
  return {
    emit(root, payload) { emitter.emit('change:' + root, payload) },
    subscribe(root, listener) {
      const key = 'change:' + root
      emitter.on(key, listener)
      return () => emitter.off(key, listener)
    },
    close() { emitter.removeAllListeners() },
  }
}
