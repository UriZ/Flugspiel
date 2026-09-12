// Minimal game-shaped objects for precise, hand-built codec edge cases.
// The integration suites use the real `Game`; this exists only so state-codec
// tests can construct states that are hard to reach in a live game (all launchers
// dead, empty launcher array, entities at negative coordinates).

/** A named class whose instances are `{x, y}` — for kindOf tests without the vendor. */
export function classNamed(name) {
  return { [name]: class {} }[name];
}

/**
 * @param {{launchers?: object[], selected?: number, enemy?: object[],
 *          shock?: object[], player?: object[], state?: string,
 *          score?: number, wave?: number}} opts
 */
export function fakeGame({
  launchers = [],
  selected = -1,
  enemy = [],
  shock = [],
  player = [],
  state = 'playing',
  score = 0,
  wave = 0,
} = {}) {
  const groups = { enemy_missiles: enemy, shock_waves: shock, player_missiles: player };
  return {
    state,
    score,
    waveNumber: wave,
    launchers,
    selectedLauncher: selected >= 0 ? launchers[selected] : null,
    entities: { getGroup: (name) => groups[name] ?? [] },
  };
}

export function fakeLauncher({ type = 'sam', x = 0, y = 1219, hp = 1, maxHp = 1, alive = true } = {}) {
  return { type, x, y, hp, maxHp, alive };
}
