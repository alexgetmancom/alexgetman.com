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

export type FlowTransition<TData> = {
  data: TData;
  next: string | null;
};

/** Executes one transport-neutral step transition for an adapter. */
export function acceptFlow<TData, TInput, TScreen>(
  flow: Flow<TData, TInput, TScreen>,
  stepName: string,
  input: TInput,
  data: TData,
): FlowTransition<TData> | null {
  const step = flow.steps[stepName];
  if (!step?.accept) return null;
  const nextData = step.accept(input, data);
  return { data: nextData, next: step.next(nextData) };
}

/** Resolves the prompt descriptor without coupling a flow to Telegram or HTTP. */
export function promptFlow<TData, TInput, TScreen>(flow: Flow<TData, TInput, TScreen>, stepName: string, env: unknown): TScreen | null {
  return flow.steps[stepName]?.prompt(env) ?? null;
}
