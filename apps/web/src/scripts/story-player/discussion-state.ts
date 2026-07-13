export type DiscussionState = {
  visible: boolean;
  isManualPaused: boolean;
  manualPausedBeforeDiscussion: boolean;
};

export function setDiscussionVisibility(state: DiscussionState, visible: boolean): DiscussionState {
  if (visible === state.visible) return state;
  if (visible) {
    return {
      visible: true,
      isManualPaused: true,
      manualPausedBeforeDiscussion: state.isManualPaused,
    };
  }
  return {
    visible: false,
    isManualPaused: state.manualPausedBeforeDiscussion,
    manualPausedBeforeDiscussion: state.manualPausedBeforeDiscussion,
  };
}
