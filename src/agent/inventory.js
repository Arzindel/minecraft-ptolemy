'use strict';

const { EventEmitter } = require('events');

// The agent's inventory: 27 slots (1-27, three rows of nine in the game). Nothing can read it, but
// `agent setitem <slot> <item> <count> <variant>` writes it (e.g. "agent setitem 1 wood 8 1" puts 8
// Spruce Wood in slot 1). So instead of knowing what's in a slot, Ptolemy makes sure of it: a held
// slot is refilled with its item every few seconds (inventory.refreshSeconds), so it never runs out,
// and the model is told what it holds. There is no way to empty a slot (a count of 0 gives 1), so
// releasing one only stops tracking it: what's in it becomes unknown again.
//
// Slots 1-26 can be held. Slot 27 is scratch space: give_item puts an item there and drops it.

const SLOTS = 27;
const SCRATCH_SLOT = 27;
const HOLD_SLOTS = SCRATCH_SLOT - 1;
const MAX_COUNT = 64;
const MAX_VARIANT = 32767;
const TICK_MS = 250;

/** An item id as setitem takes it ("oak_planks", "minecraft:wood"), or throws. */
function itemId(item) {
  const id = String(item || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!/^[a-z0-9_:.]{1,64}$/.test(id)) throw new Error(`"${item}" isn't a valid item id (e.g. oak_planks, cobblestone, wood)`);
  return id;
}

function slotNumber(slot, max = SLOTS) {
  const n = Number(slot);
  if (max === HOLD_SLOTS && n === SCRATCH_SLOT) throw new Error(`slot ${SCRATCH_SLOT} is scratch space (give_item uses it): hold 1-${HOLD_SLOTS}`);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`the slot must be a whole number from 1 to ${max}`);
  return n;
}

function variantNumber(data) {
  const n = Number(data ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > MAX_VARIANT) throw new Error(`the variant must be a whole number from 0 to ${MAX_VARIANT}`);
  return n;
}

class Inventory extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
   * @param {import('../settings').Settings} deps.settings
   * @param {import('../world/manager').WorldManager} deps.worlds   the held slots are kept per world
   * @param {() => boolean} [deps.ready]   false while there's no agent (refilling would create one)
   */
  constructor({ bridge, settings, worlds, ready = () => true }) {
    super();
    Object.assign(this, { bridge, settings, worlds, ready });
    this._last = 0;
    this._refilling = false;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._timer.unref();
  }

  /** The held slots of the open world: [{ slot, item, data }]. */
  held() {
    return this.worlds.current ? this.worlds.current.data.held : [];
  }

  /** Put `count` of an item in a slot, once. Resolves to the game's reply. */
  setItem(slot, item, count, data = 0) {
    return this.bridge.sendCommand(`agent setitem ${slot} ${item} ${count} ${data}`, { quiet: true });
  }

  /** Keep a slot (1-26) stocked with an item. Checks the game takes the item first; throws if not. */
  async hold(slot, item, data = 0) {
    const n = slotNumber(slot, HOLD_SLOTS);
    const id = itemId(item);
    const variant = variantNumber(data);
    if (!this.worlds.current) throw new Error('no world is loaded yet (is Minecraft connected?)');
    if (!this.bridge.connected) throw new Error('Minecraft is not connected');
    if (!this.ready()) throw new Error('there\'s no agent yet: create it first (the Create Agent button)');
    const res = await this.setItem(n, id, this.settings.get('inventory.amount'), variant);
    if (!res.ok) throw new Error(`the game refused "agent setitem ${n} ${id}": ${res.statusMessage}`);
    this.worlds.current.setHeld(n, id, variant);
    this.emit('change');
    return { slot: n, item: id, data: variant };
  }

  /** Stop keeping a slot stocked (it can't be emptied: what's left in it just isn't tracked any more). */
  release(slot) {
    const n = slotNumber(slot, HOLD_SLOTS);
    const old = this.worlds.current ? this.worlds.current.releaseHeld(n) : null;
    this.emit('change');
    return old;
  }

  message() {
    return {
      type: 'inventory',
      held: this.held(),
      slots: SLOTS,
      scratch: SCRATCH_SLOT,
      amount: this.settings.get('inventory.amount'),
    };
  }

  close() {
    clearInterval(this._timer);
  }

  _tick() {
    const every = this.settings.get('inventory.refreshSeconds') * 1000;
    const held = this.held();
    if (!every || !held.length || !this.bridge.connected || !this.ready() || this._refilling || Date.now() - this._last < every) return;
    this._last = Date.now();
    this._refilling = true;
    const amount = this.settings.get('inventory.amount');
    Promise.all(held.map((h) => this.setItem(h.slot, h.item, amount, h.data)))
      .catch(() => {})
      .finally(() => { this._refilling = false; });
  }
}

module.exports = { Inventory, itemId, slotNumber, variantNumber, SLOTS, SCRATCH_SLOT, HOLD_SLOTS, MAX_COUNT };
