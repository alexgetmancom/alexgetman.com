export type PublicationKind = "post" | "video";

/** Transport-neutral shape for a conversational publication workflow. */
export type FlowStep<TData, TInput = unknown> = {
  name: string;
  accept?: (input: TInput, data: TData) => TData | Promise<TData>;
  next: (data: TData) => string | null;
  back?: (data: TData) => string | null;
};

export type Flow<TData, TInput = unknown> = {
  kind: PublicationKind;
  steps: Record<string, FlowStep<TData, TInput>>;
};

export type FlowTransition<TData> = {
  data: TData;
  next: string | null;
};

/** Executes one transport-neutral step transition for an adapter. */
export async function acceptFlow<TData, TInput>(
  flow: Flow<TData, TInput>,
  stepName: string,
  input: TInput,
  data: TData,
): Promise<FlowTransition<TData> | null> {
  const step = flow.steps[stepName];
  if (!step?.accept) return null;
  const nextData = await step.accept(input, data);
  return { data: nextData, next: step.next(nextData) };
}
