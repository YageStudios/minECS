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

type TrackableWorld = World & {
  [$deltaDirtyState]?: DeltaDirtyState;
};

export const getState = (world: World): DeltaDirtyState | undefined => {
  return (world as TrackableWorld)[$deltaDirtyState];
};

export const activateDeltaDirtyTracking = (world: World) => {
  const trackableWorld = world as TrackableWorld;
  if (!trackableWorld[$deltaDirtyState]) {
    trackableWorld[$deltaDirtyState] = { dirtyProps: new Map<Store, DirtyBucket>() };
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
