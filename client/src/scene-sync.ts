/**
 * One sync path from the `SceneStore` state to the scene graph.
 *
 * The ghost models came from concurrent `syncInstances` runs racing each
 * other: every store change fires a sync, each missing piece loads its
 * model asynchronously, and a delete (or undo) landing mid-load left the
 * late `await` adding a group the state no longer wanted — or two runs
 * loading the same piece adding two groups while the map kept only one.
 * Replacing `state` wholesale (undo/redo/replace/room switch) made it
 * worse: the in-flight run kept positioning from its stale item objects.
 *
 * This synchronizer is the single reconciliation point both the app and
 * the headless `check:scene-sync` drive. It serializes runs with an epoch:
 * a newer run aborts the older one, and every `await` re-checks that its
 * piece is still wanted before attaching anything. The scene therefore
 * always converges to exactly one model per state piece, at the state's
 * position and rotation, with nothing left over.
 */

import type { SceneItem } from "@fitroom/shared";
import { yieldToUI } from "./boot-tasks";

export interface SceneEntry<G> {
  item: SceneItem;
  group: G;
  variant: string;
}

export interface SceneSyncHooks<G> {
  load(item: SceneItem): Promise<G>;
  place(group: G, item: SceneItem): void;
  attach(group: G): void;
  detach(group: G): void;
  dispose?(group: G): void;
}

function cloneItem(item: SceneItem): SceneItem {
  return {
    ...item,
    position: { ...item.position },
  };
}

export class SceneSynchronizer<G> {
  readonly instances = new Map<string, SceneEntry<G>>();
  private epoch = 0;

  constructor(private readonly hooks: SceneSyncHooks<G>) {}

  /** Reconcile the scene with the given state items. Never throws. */
  async sync(stateItems: readonly SceneItem[]): Promise<void> {
    const epoch = (this.epoch += 1);
    const wanted = new Map<string, SceneItem>();
    for (const item of stateItems) wanted.set(item.instanceId, item);

    for (let index = 0; index < stateItems.length; index += 1) {
      // Each model's parse and variant runs in its own task: yield
      // between pieces (idle time when available, else a zero time-out)
      // so the setup screen stays responsive while the room fills in.
      if (index > 0) {
        await yieldToUI();
        if (epoch !== this.epoch) return;
      }
      const item = stateItems[index] as SceneItem;
      if (epoch !== this.epoch) return;
      const existing = this.instances.get(item.instanceId);
      if (existing === undefined) {
        let group: G;
        try {
          group = await this.hooks.load(cloneItem(item));
        } catch {
          continue;
        }
        if (epoch !== this.epoch) {
          this.hooks.dispose?.(group);
          return;
        }
        const current = wanted.get(item.instanceId);
        if (current === undefined) {
          this.hooks.dispose?.(group);
          continue;
        }
        if (this.instances.has(item.instanceId)) {
          // A newer run already attached this piece; drop the duplicate.
          this.hooks.dispose?.(group);
          const kept = this.instances.get(item.instanceId);
          if (kept !== undefined) this.hooks.place(kept.group, current);
          continue;
        }
        this.hooks.place(group, current);
        this.hooks.attach(group);
        this.instances.set(item.instanceId, {
          item: cloneItem(current),
          group,
          variant: current.variant,
        });
      } else {
        const current = wanted.get(item.instanceId);
        if (current === undefined) continue;
        if (existing.variant !== current.variant) {
          const oldGroup = existing.group;
          let group: G;
          try {
            group = await this.hooks.load(cloneItem(current));
          } catch {
            continue;
          }
          if (epoch !== this.epoch) {
            this.hooks.dispose?.(group);
            return;
          }
          if (wanted.get(item.instanceId) === undefined) {
            this.hooks.dispose?.(group);
            continue;
          }
          this.hooks.detach(oldGroup);
          this.hooks.dispose?.(oldGroup);
          this.hooks.place(group, current);
          this.hooks.attach(group);
          existing.group = group;
          existing.variant = current.variant;
        } else {
          this.hooks.place(existing.group, current);
        }
        existing.item = cloneItem(current);
      }
    }

    if (epoch !== this.epoch) return;
    for (const [id, entry] of [...this.instances]) {
      if (!wanted.has(id)) {
        this.hooks.detach(entry.group);
        this.hooks.dispose?.(entry.group);
        this.instances.delete(id);
      }
    }
  }
}
