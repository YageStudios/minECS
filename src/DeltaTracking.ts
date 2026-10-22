import type { Store } from "./Storage";
import type { World } from "./Types";

export const $deltaDirtyState = Symbol("deltaDirtyState");

type DirtyBucket = {
  marks: Uint32Array;
  ids: number[];
  epoch: number;
};

type DeltaDirtyState = {
  dirtyProps: Map<Store, DirtyBucket>;
};

const $deltaHolder = Symbol("deltaHolder");

/**
 * Plain, stable-shaped holder for the tracking state. The world itself is a function object with
 * many properties (dictionary mode), so component setters check `holder.state` instead of doing a
 * hash lookup on the world for every write.
 */
export type DeltaHolder = { state: DeltaDirtyState | undefined };

type TrackableWorld = World & {
  [$deltaDirtyState]?: DeltaDirtyState;
  [$deltaHolder]?: DeltaHolder;
};

export const getDeltaHolder = (world: World): DeltaHolder => {
  const trackableWorld = world as TrackableWorld;
  return trackableWorld[$deltaHolder] || (trackableWorld[$deltaHolder] = { state: trackableWorld[$deltaDirtyState] });
};

export const getState = (world: World): DeltaDirtyState | undefined => {
  return getDeltaHolder(world).state;
};

export const activateDeltaDirtyTracking = (world: World) => {
  const holder = getDeltaHolder(world);
  if (!holder.state) {
    holder.state = { dirtyProps: new Map<Store, DirtyBucket>() };
    // Mirrored on the world for anything that still reads the symbol directly.
    (world as TrackableWorld)[$deltaDirtyState] = holder.state;
  }
};

export const clearDeltaDirtyTracking = (world: World) => {
  const state = getState(world);
  if (state) {
    state.dirtyProps.forEach((bucket) => {
      bucket.ids.length = 0;
      bucket.epoch++;
      if (bucket.epoch === 0) {
        bucket.marks.fill(0);
        bucket.epoch = 1;
      }
    });
  }
};

export const markDeltaDirty = (world: World, propStore: Store, eid: number) => {
  const state = getState(world);
  if (!state) return;

  let bucket = state.dirtyProps.get(propStore);
  if (!bucket) {
    bucket = {
      marks: new Uint32Array(world.size),
      ids: [],
      epoch: 1,
    };
    state.dirtyProps.set(propStore, bucket);
  }
  if (bucket.marks[eid] !== bucket.epoch) {
    bucket.marks[eid] = bucket.epoch;
    bucket.ids.push(eid);
  }
};

export const consumeDeltaDirtyTracking = (world: World): Map<Store, number[]> => {
  const state = getState(world);
  if (!state || state.dirtyProps.size === 0) {
    return new Map<Store, number[]>();
  }

  const consumed = new Map<Store, number[]>();
  state.dirtyProps.forEach((bucket, store) => {
    if (bucket.ids.length === 0) return;
    const ids = bucket.ids;
    consumed.set(store, ids);
    bucket.ids = [];
    bucket.epoch++;
    if (bucket.epoch === 0) {
      bucket.marks.fill(0);
      bucket.epoch = 1;
    }
  });
  return consumed;
};
