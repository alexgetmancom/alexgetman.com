export type PublicationKind = "post" | "video";

/** Transport-neutral shape for a conversational publication workflow. */
export type FlowStep<TData, TInput = unknown, TScreen = unknown> = {
  name: string;
  prompt: (env: unknown) => TScreen;
  accept?: (input: TInput, data: TData) => TData;
  next: (data: TData) => string | null;
  back?: (data: TData) => string | null;
};

export type Flow<TData, TInput = unknown, TScreen = unknown> = {
  kind: PublicationKind;
  steps: Record<string, FlowStep<TData, TInput, TScreen>>;
};
