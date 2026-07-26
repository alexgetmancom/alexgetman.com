<!-- =============================================================================
  Полоса прогресса поста в двух видах: одна дорожка либо сегменты по числу
  картинок (как в Instagram-сторис). Своего состояния нет.

  Заполнением управляет progress.ts из корня — он анимирует элемент, который
  прилетает сюда через `bind:progressFill`, поэтому `<i>` рендерится только
  внутри активного сегмента: ровно одна ссылка на элемент за раз.
============================================================================= -->
<script lang="ts">
import type { PlayerPost } from "./payload";

let {
  title,
  gallerySequence,
  gallerySubIndex,
  progressFill = $bindable(null),
  onselectgallery,
}: {
  title: string;
  gallerySequence: NonNullable<PlayerPost["gallery"]>;
  gallerySubIndex: number;
  progressFill?: HTMLElement | null;
  onselectgallery?: (index: number) => void;
} = $props();

const segmented = $derived(gallerySequence.length >= 2);
</script>

{#if segmented}
  <!-- Не tablist: панелей, которые переключались бы вкладками, здесь нет —
       это индикатор слайдов, часть которых кликабельна. role="tab" без
       tabpanel/aria-controls только вводил скринридер в заблуждение, а
       неизображённые сегменты объявлялись вкладками, до которых нельзя
       дойти клавиатурой. Текущий слайд помечается aria-current. -->
  <div class="story-visual-progress story-visual-progress--segmented" role="group" aria-label={`${title} — slides`}>
    {#each gallerySequence as media, index}
      <button
        type="button"
        class="story-visual-progress__segment"
        class:is-complete={index < gallerySubIndex}
        class:is-clickable={media.type === "image"}
        aria-current={index === gallerySubIndex ? "true" : undefined}
        aria-label={`${index + 1} / ${gallerySequence.length}`}
        disabled={media.type !== "image"}
        onclick={(event) => {
          event.preventDefault();
          onselectgallery?.(index);
        }}
      >
        {#if index === gallerySubIndex}
          <i bind:this={progressFill}></i>
        {/if}
      </button>
    {/each}
  </div>
{:else}
  <span class="story-visual-progress" aria-hidden="true">
    <i bind:this={progressFill}></i>
  </span>
{/if}

<style>
  .story-visual-progress {
    position: absolute;
    z-index: var(--z-overlay);
    top: 2px;
    left: 6px;
    right: 6px;
    height: 4px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.32);
    pointer-events: none;
  }

  .story-visual-progress i {
    display: block;
    width: 100%;
    height: 100%;
    transform: scaleX(0);
    transform-origin: left center;
    background: var(--accent);
    box-shadow: 0 0 12px rgba(220, 38, 38, 0.62);
  }

  /* Имя keyframes глобальное (-global-): его подставляет progress.ts из JS. */
  @keyframes -global-storyProgressHorizontal {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }

  /* Сегментированная полоса (2+ картинки в посте) — как в Instagram-сторис:
     один сегмент на слайд, текущий заполняется анимацией, пройденные — сплошные. */
  .story-visual-progress--segmented {
    display: flex;
    gap: 4px;
    background: none;
    pointer-events: auto;
  }

  .story-visual-progress__segment {
    position: relative;
    flex: 1 1 0;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    overflow: hidden;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.32);
    cursor: default;
    -webkit-appearance: none;
    appearance: none;
  }

  .story-visual-progress__segment.is-complete {
    background: var(--accent);
  }

  .story-visual-progress__segment.is-clickable {
    cursor: pointer;
    pointer-events: auto;
  }

  /* ---- Телефон (≤760px): полоса уходит под вырез, края скругляются ---- */
  @media (max-width: 760px) {
    .story-visual-progress {
      height: 4px;
      top: calc(env(safe-area-inset-top, 0) + 2px);
      left: 0.55rem;
      right: 0.55rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.24);
    }
  }
</style>
