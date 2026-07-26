<!-- =============================================================================
  Оверлей play/pause: круг с иконкой, вспыхивающий поверх сцены после клика.
  Чисто презентационный, состояния нет. Иконка собрана из ::before/::after —
  отдельных SVG для двух фигур не заводим.

  `overlayTick` — счётчик из StoryPlayer, а не булев флаг: {#key} по нему
  перемонтирует блок и тем перезапускает анимацию на каждом клике, даже если
  пауза переключается туда-обратно. Ноль означает «кликов ещё не было».
============================================================================= -->
<script lang="ts">
let { paused, overlayTick }: { paused: boolean; overlayTick: number } = $props();
</script>

{#key overlayTick}
  {#if overlayTick > 0}
    <div class="play-pause-overlay is-visible">
      <div class={`play-pause-icon ${paused ? "is-paused" : "is-playing"}`}></div>
    </div>
  {/if}
{/key}

<style>
  .play-pause-overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.12);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }

  .play-pause-overlay.is-visible {
    animation: playPauseFlash 0.65s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  .play-pause-icon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: grid;
    place-items: center;
    position: relative;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  /* Пауза: две вертикальные полосы. */
  .play-pause-icon.is-paused::before,
  .play-pause-icon.is-paused::after {
    content: "";
    width: 6px;
    height: 20px;
    background: #ffffff;
    border-radius: 2px;
    position: absolute;
    top: 22px;
  }
  .play-pause-icon.is-paused::before {
    left: 23px;
  }
  .play-pause-icon.is-paused::after {
    right: 23px;
  }

  /* Плей: треугольник. */
  .play-pause-icon.is-playing::before {
    content: "";
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 10px 0 10px 18px;
    border-color: transparent transparent transparent #ffffff;
    position: absolute;
    left: 25px;
    top: 22px;
  }

  @keyframes playPauseFlash {
    0% {
      opacity: 0;
      transform: scale(0.85);
    }
    15% {
      opacity: 1;
      transform: scale(1);
    }
    85% {
      opacity: 1;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(1.08);
    }
  }
</style>
