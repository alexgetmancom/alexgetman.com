import type { StoryPost } from "./types";

type StoryDebugState = {
  active: number;
  posts: StoryPost[];
  paused: boolean;
  isManualPaused: boolean;
  isInteractionPaused: boolean;
  progressActive: boolean;
  progressRestartBlocked: boolean;
  advanceTimer: number | null;
};

export function renderDebugState(debugPanel: HTMLPreElement | null, state: StoryDebugState): void {
  if (!debugPanel) return;
  debugPanel.textContent = JSON.stringify(
    {
      active: state.active,
      postId: state.posts[state.active]?.id,
      paused: state.paused,
      isManualPaused: state.isManualPaused,
      isInteractionPaused: state.isInteractionPaused,
      progressActive: state.progressActive,
      progressRestartBlocked: state.progressRestartBlocked,
      advanceTimer: Boolean(state.advanceTimer),
      mediaType: state.posts[state.active]?.mediaType || null,
      url: state.posts[state.active]?.url || null,
    },
    null,
    2,
  );
}
