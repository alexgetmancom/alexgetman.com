import type { StudioLocale } from "../foundation/locale.js";

/** Shared, transport-neutral primitives for Studio application commands and reads. */
export type StudioActorId = number;
export type { StudioLocale };

/**
 * Shared vocabulary for an owned Studio entity. Individual entities may have
 * richer fields, but adapters should not need a separate verb set for posts
 * and videos.
 */
export type StudioEntityContract<Id, CreateInput, EditInput, ScheduleInput, Details, Status, Validation> = {
  create(actorId: StudioActorId, input: CreateInput): Id;
  get(actorId: StudioActorId, id: Id): Details;
  list(actorId: StudioActorId, limit?: number): Details[];
  edit(actorId: StudioActorId, id: Id, input: EditInput): void;
  preview(actorId: StudioActorId, id: Id): Details;
  validate(actorId: StudioActorId, id: Id): Validation | Promise<Validation>;
  publish(actorId: StudioActorId, id: Id): unknown | Promise<unknown>;
  schedule(actorId: StudioActorId, id: Id, input: ScheduleInput): unknown | Promise<unknown>;
  cancel(actorId: StudioActorId, id: Id): void;
  status(actorId: StudioActorId, id: Id): Status;
  history(actorId: StudioActorId, id: Id, limit?: number): unknown[];
};
