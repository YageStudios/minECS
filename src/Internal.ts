/**
 * Symbol keys for world-internal caches.
 *
 * The world is a function object, and V8 drops a function into dictionary mode as soon as more than a
 * handful of properties are added to it one by one (and any later symbol-keyed addition counts). So
 * createWorld declares every one of these slots up front, in a single defineProperties call, and the
 * rest of the code only ever overwrites them.
 */
export const $bitTable = Symbol("bitTable");
export const $stepSystems = Symbol("stepSystems");
export const $drawSystems = Symbol("drawSystems");
export const $deltaHolder = Symbol("deltaHolder");
export const $deltaDirtyState = Symbol("deltaDirtyState");
export const $serialPlan = Symbol("serialPlan");
export const $reuseThreshold = Symbol("reuseThreshold");
/** Entities the world's stores were allocated for (world.size can later shrink, the stores do not). */
export const $capacity = Symbol("capacity");

export const WORLD_INTERNAL_SLOTS: symbol[] = [
  $bitTable,
  $stepSystems,
  $drawSystems,
  $deltaHolder,
  $deltaDirtyState,
  $serialPlan,
  $reuseThreshold,
  $capacity,
];
