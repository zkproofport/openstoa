/**
 * React needs to be told it is inside a test before `act` will behave.
 *
 * Without this every render logs "the current testing environment is not
 * configured to support act(...)" — noise that trains people to ignore the
 * output, which is the last thing a test log should do.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `requestAnimationFrame` exists on a device and in a browser, and not in Node.
 *
 * A screen that defers work to the next frame (ChatRoomScreen does, to scroll
 * after a row is added) throws `ReferenceError` on the line that schedules it —
 * and because that happens inside an effect, what the test SEES is the work
 * never happening: a restored row that is not restored, with an error that
 * names neither the row nor the screen.
 *
 * Runs the callback on a macrotask rather than synchronously: the point of the
 * call is "after this render", so running it inline would let a screen observe
 * state it could never observe on a device. `flush()` in `render.tsx` drains it.
 */
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id as unknown as NodeJS.Timeout)) as typeof cancelAnimationFrame;
}
