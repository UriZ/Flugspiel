// Public entry point. Spec #2 §2.4.

import { Game } from './vendor/game.js';
import { FlyBridge } from './fly-bridge.js';

export { FlyBridge } from './fly-bridge.js';

/**
 * Construct the game and its bridge. The Game constructor starts its own rAF loop,
 * which resolves `game.update` at call time — so the bridge's patch takes effect
 * even though the loop is already running.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{emitHz?: number, mode?: 'human'|'fly'}} [options] defaults: 20 Hz, human
 * @returns {{game: Game, bridge: FlyBridge}}
 */
export function createGame(canvas, options = {}) {
  const game = new Game(canvas);
  return { game, bridge: new FlyBridge(game, options) };
}
