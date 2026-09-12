/**
 * UpgradeState — tracks purchased upgrades and applies stat effects to weapons.
 *
 * Effect application order (per spec):
 *   1. 'set'      — override base value directly
 *   2. 'multiply' — scale the (possibly set) value
 *   3. 'add'      — additive offset against the (possibly set/multiplied) value
 *
 * upgradeConfig format:
 * {
 *   upgrades: [
 *     {
 *       id: 'sam_fast_reload',
 *       label: 'Fast Reload',
 *       cost: 100,
 *       prereqs: ['sam_unlock'],       // optional
 *       repeatable: false,             // optional — if true, can be bought multiple times
 *       effects: [
 *         { weapon: 'sam', stat: 'fireRate', op: 'multiply', value: 0.7 },
 *       ]
 *     },
 *     ...
 *   ]
 * }
 */
export class UpgradeState {
  constructor() {
    /** @type {Set<string>} IDs of all purchased (non-repeatable) upgrades */
    this.purchased = new Set();

    /** @type {Record<string, number>} purchase count for repeatable upgrades */
    this.purchaseCounts = {};
  }

  /**
   * Check whether a given upgrade can be purchased.
   * @param {{ id: string, cost: number, prereqs?: string[], repeatable?: boolean }} upgradeDef
   * @param {number} cash
   * @returns {boolean}
   */
  canPurchase(upgradeDef, cash) {
    if (cash < upgradeDef.cost) return false;

    if (!upgradeDef.repeatable && this.purchased.has(upgradeDef.id)) return false;

    if (upgradeDef.prereqs) {
      for (const prereq of upgradeDef.prereqs) {
        if (!this.purchased.has(prereq)) return false;
      }
    }

    return true;
  }

  /**
   * Purchase an upgrade: deduct cash from game, record purchase.
   * @param {{ id: string, cost: number, repeatable?: boolean }} upgradeDef
   * @param {{ cash: number }} game  — game object with a mutable .cash field
   * @returns {boolean} true if purchase succeeded
   */
  purchase(upgradeDef, game) {
    if (!this.canPurchase(upgradeDef, game.cash)) return false;

    game.cash -= upgradeDef.cost;

    if (upgradeDef.repeatable) {
      this.purchaseCounts[upgradeDef.id] = (this.purchaseCounts[upgradeDef.id] || 0) + 1;
      // Also track in purchased for prereq checking
      this.purchased.add(upgradeDef.id);
    } else {
      this.purchased.add(upgradeDef.id);
    }

    return true;
  }

  /**
   * @param {string} upgradeId
   * @returns {boolean}
   */
  hasPurchased(upgradeId) {
    return this.purchased.has(upgradeId);
  }

  /**
   * Collect all purchased effects that apply to a given weapon type.
   * @param {string} weaponType  — e.g. 'sam', 'vulkan', 'laser'
   * @param {{ upgrades: Array }} upgradeConfig
   * @returns {Array<{ stat: string, op: 'set'|'multiply'|'add', value: number, count: number }>}
   */
  getEffectsForWeapon(weaponType, upgradeConfig) {
    const effects = [];
    if (!upgradeConfig || !upgradeConfig.upgrades) return effects;

    for (const def of upgradeConfig.upgrades) {
      if (!def.effects) continue;

      const purchaseCount = def.repeatable
        ? (this.purchaseCounts[def.id] || 0)
        : (this.purchased.has(def.id) ? 1 : 0);

      if (purchaseCount === 0) continue;

      for (const effect of def.effects) {
        if (effect.weapon === weaponType) {
          effects.push({ ...effect, count: purchaseCount });
        }
      }
    }

    return effects;
  }

  /**
   * Recompute a weapon's stats from its _baseStats + all purchased effects.
   * Mutates the weapon object's stat properties directly.
   *
   * Effect application order:
   *   1. Apply all 'set' ops (last one wins per stat)
   *   2. Apply all 'multiply' ops (multiplied together per stat)
   *   3. Apply all 'add' ops (summed per stat)
   *
   * @param {Object} weapon  — launcher or weapon entity with _baseStats and a .type field
   * @param {{ upgrades: Array }|null} upgradeConfig
   */
  applyToWeapon(weapon, upgradeConfig) {
    if (!weapon._baseStats) return;

    // Start from base values
    const result = { ...weapon._baseStats };

    if (!upgradeConfig) {
      // No config provided — just reset to base stats
      for (const [stat, value] of Object.entries(result)) {
        weapon[stat] = value;
      }
      return;
    }

    const effects = this.getEffectsForWeapon(weapon.type, upgradeConfig);
    if (effects.length === 0) {
      // No effects — just reset to base
      for (const [stat, value] of Object.entries(result)) {
        weapon[stat] = value;
      }
      return;
    }

    // Pass 1: 'set' — override base (last set wins)
    for (const effect of effects) {
      if (effect.op === 'set') {
        // For repeatable upgrades the count is already baked into the effect value
        // (the upgrade def should define value per purchase)
        result[effect.stat] = effect.value;
      }
    }

    // Pass 2: 'multiply' — multiply together
    for (const effect of effects) {
      if (effect.op === 'multiply' && result[effect.stat] !== undefined) {
        // For repeatable upgrades, apply the multiplier `count` times
        result[effect.stat] *= Math.pow(effect.value, effect.count);
      }
    }

    // Pass 3: 'add' — additive offset
    for (const effect of effects) {
      if (effect.op === 'add' && result[effect.stat] !== undefined) {
        result[effect.stat] += effect.value * effect.count;
      }
    }

    // Write computed values back to weapon
    for (const [stat, value] of Object.entries(result)) {
      weapon[stat] = value;
    }
  }

  /**
   * Reset all purchased upgrades. Call at game start.
   */
  reset() {
    this.purchased.clear();
    this.purchaseCounts = {};
  }
}
