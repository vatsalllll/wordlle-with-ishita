const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createBloomLoader({ onClose = () => {} } = {}) {
  const root = document.getElementById('bloom-loader');
  const status = document.getElementById('bloom-status');
  const errorMessage = document.getElementById('bloom-error');
  const skipButton = document.getElementById('bloom-skip');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phases = {
    seed: 'Gathering a little stardust…',
    grow: 'A little sunshine, growing from the ground up…',
    bloom: 'Two flowers. A whole little universe.',
    sunshine: 'Bringing your garden together…',
  };
  let scene;
  let scenePromise;
  let sceneFailed = false;
  let introActive = true;
  let introPromise;
  let introGeneration = 0;
  let skipCurrent;
  let pending = 0;
  let resolveIdle;
  let requestTimer;

  // HTML covers the screen before modules arrive; promote it to a real modal now.
  if (root.open) root.close();
  root.showModal();

  function getScene() {
    if (!scenePromise) {
      scenePromise = import('/sunflower-scene.js').then(({ createSunflowerScene }) => {
        scene = createSunflowerScene(document.getElementById('bloom-canvas'), {
          reducedMotion,
          onPhase(phase) {
            root.dataset.phase = phase;
            if (introActive && pending === 0) status.textContent = phases[phase];
          },
        });
        return scene;
      }).catch((error) => {
        console.error('Sunflower scene could not start:', error);
        sceneFailed = true;
        errorMessage.hidden = false;
        errorMessage.textContent = 'Your browser could not start the 3D sunflower scene. You can still enter the game.';
        return null;
      });
    }
    return scenePromise;
  }

  function open(mode) {
    root.dataset.mode = mode;
    root.dataset.state = 'loading';
    if (!root.open) root.showModal();
  }

  function close() {
    clearTimeout(requestTimer);
    requestTimer = null;
    if (root.open) root.close();
    scene?.pause();
    onClose();
  }

  function waitForNetwork() {
    return pending === 0 ? Promise.resolve() : new Promise((resolve) => { resolveIdle = resolve; });
  }

  function loading(active, message = 'Opening your little garden…') {
    pending = Math.max(0, pending + (active ? 1 : -1));
    if (active) status.textContent = message;
    if (pending === 0) {
      resolveIdle?.();
      resolveIdle = null;
      clearTimeout(requestTimer);
      requestTimer = null;
      if (!introActive && root.open && root.dataset.mode === 'request') close();
      return;
    }
    if (introActive || root.open || requestTimer) return;
    // Fast guesses stay instant. Slow work gets the same full-screen scene, not a toast.
    requestTimer = setTimeout(() => {
      requestTimer = null;
      if (!pending || introActive) return;
      open('request');
      void getScene().then((renderer) => {
        if (root.open && root.dataset.mode === 'request' && !introActive) renderer?.idle();
      });
    }, 250);
  }

  function intro(ready = Promise.resolve()) {
    if (introPromise) return introPromise;
    const generation = ++introGeneration;
    let skipped = false;
    let startupFailed = false;
    introActive = true;
    clearTimeout(requestTimer);
    requestTimer = null;
    root.dataset.phase = 'seed';
    errorMessage.hidden = !sceneFailed;
    skipButton.textContent = 'Skip intro ↗';
    status.textContent = phases.seed;
    open('intro');
    const skippedPromise = new Promise((resolve) => {
      skipCurrent = () => {
        skipped = true;
        scene?.finish();
        resolve();
      };
    });
    const bloom = getScene().then((renderer) => {
      if (generation !== introGeneration) return;
      if (skipped || !introActive) { if (!root.open) renderer?.pause(); return; }
      return renderer?.bloom();
    });
    const actualWork = Promise.resolve(ready).catch((error) => {
      console.error('Game initialization failed:', error);
      startupFailed = true;
      errorMessage.hidden = false;
      errorMessage.textContent = 'The game could not finish loading. Continue to see the connection status and try again.';
    });
    introPromise = (async () => {
      await Promise.all([Promise.race([bloom, skippedPromise]), actualWork]);
      await waitForNetwork();
      if (!skipped && (sceneFailed || startupFailed)) {
        status.textContent = 'The game is available without the animation.';
        skipButton.textContent = 'Continue to game ↗';
        await skippedPromise;
      } else if (!skipped) {
        root.dataset.state = 'welcome';
        status.textContent = 'Your little word garden is ready.';
        skipButton.textContent = 'Let’s play ↗';
        await Promise.race([wait(reducedMotion ? 500 : 1900), skippedPromise]);
      }
      // A new navigation can add work while the exit is in flight; never hide it early.
      do {
        await waitForNetwork();
        root.dataset.state = 'leaving';
        if (!reducedMotion) await wait(680);
      } while (pending > 0);
      introActive = false;
      close();
    })().finally(() => {
      introPromise = null;
      skipCurrent = null;
    });
    return introPromise;
  }

  skipButton.addEventListener('click', () => { if (introActive) skipCurrent?.(); });
  root.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (introActive) skipCurrent?.();
  });
  window.addEventListener('pagehide', (event) => {
    scene?.pause();
    if (!event.persisted) scene?.dispose();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && root.open) scene?.idle();
  });

  return {
    intro,
    loading,
    get introActive() { return introActive; },
    get visible() { return root.open; },
  };
}
