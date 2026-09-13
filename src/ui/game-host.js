// The game iframe and the closed loop through it — #5 §2.4, §2.5, §6.4.
//
// The game runs in a same-origin <iframe src="game.html">, not in this document. The
// vendored Renderer sizes from `window.innerWidth` and Input uses raw `clientX`
// (`vendor/engine/renderer.js:32-47`, `engine/input.js:39-43`), and `src/game/vendor/**`
// may not be edited (#2 AC6, hash-enforced). The iframe's inner `innerWidth/innerHeight`
// ARE the panel's content box, and the inner window gets its own `resize` — so the
// shell sizes nothing and touches no renderer. Any code here naming 2560, 1440 or
// `renderer` is wrong.

/**
 * @param {object} o
 * @param {HTMLIFrameElement} o.frame
 * @param {object} o.client   a BrainClient
 * @param {Function} [o.onState] every state on its way to the socket (§4.3)
 */
export async function createGameHost({ frame, client, onState }) {
  if (!frame.contentWindow?.bridge) {
    await new Promise((res) => frame.addEventListener('load', res, { once: true }));
  }
  const win = frame.contentWindow;
  const bridge = win.bridge;
  if (!bridge) throw new Error('game.html did not expose window.bridge');

  bridge.setTransport({
    send: (state) => {
      onState?.(state);
      client.sendState(state);
    },
  });

  return {
    get bridge() {
      return bridge;
    },
    get game() {
      return win.game;
    },
    /** Keys reach the game only once its frame has focus — measured (check O). */
    focusGame() {
      win.focus();
    },
    /**
     * Apply one frame's action and acknowledge it. #4 §2.3: without the result the
     * decoder treats an unconfirmed latch as committed and never learns `launcher_dead`
     * or `detached`, so the ack is sent when `ok` is true as well. The shell never
     * retries a rejected action and never re-arms the bridge, so `detached` is terminal
     * *for this shell* — the server's `halted` has a third exit through a session
     * change, which no shipped client can reach (#36).
     */
    applyAction(f) {
      const r = bridge.applyAction(f.action);
      // `ack_seq` is null until the first state is acknowledged; never send {"seq":null}.
      if (f.ackSeq !== null) client.sendResult(f.ackSeq, r);
      return r;
    },
  };
}
