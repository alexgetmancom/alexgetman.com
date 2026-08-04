import type { PublicationKind } from "./conversation-flow.js";

export type PublicationScheduleAxis = "locale" | "target";

export type PublicationCapabilities = {
  hasMetadataWizard: boolean;
  hasStoryCards: boolean;
  scheduleAxis: PublicationScheduleAxis;
};

export type PublicationSchedule = {
  values: Partial<Record<string, Date>>;
  allowPast?: boolean;
  immediateKey?: string;
};

/** The common application port for publication mutations and read models. */
export type PublicationPipeline<
  TPublication = unknown,
  TPreview = unknown,
  TValidation = unknown,
  TSchedule = unknown,
  TPublish = unknown,
  TCancel = unknown,
  TRetry = unknown,
  TTarget = string,
  TRemoveTarget = void,
  TToggleTarget = void,
> = {
  kind: PublicationKind;
  capabilities: PublicationCapabilities;
  get(actorId: number, publicationId: number): TPublication;
  preview(actorId: number, publicationId: number): TPreview;
  validate(actorId: number, publicationId: number): TValidation | Promise<TValidation>;
  schedule(actorId: number, publicationId: number, schedule: PublicationSchedule): TSchedule | Promise<TSchedule>;
  publish(actorId: number, publicationId: number): TPublish | Promise<TPublish>;
  cancel(actorId: number, publicationId: number): TCancel | Promise<TCancel>;
  retryTarget(actorId: number, publicationId: number, target: TTarget): TRetry | Promise<TRetry>;
  removeTarget(actorId: number, publicationId: number, target: TTarget): TRemoveTarget | Promise<TRemoveTarget>;
  toggleTarget(actorId: number, publicationId: number, target: TTarget): TToggleTarget | Promise<TToggleTarget>;
  slotTime(clock: string): Date;
};
