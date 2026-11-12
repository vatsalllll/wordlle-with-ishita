import * as THREE from '/vendor/three-0.181.0/three.module.min.js';

const DURATION = 6;
const ROOT = -4.8;
const FLOWERS = [
  { x: -1.22, y: 1.6, z: 0, radius: 1.3, core: 0.53, tilt: -0.09 },
  { x: 1.26, y: 0.68, z: -0.18, radius: 1.08, core: 0.45, tilt: 0.1 },
];

const motionShader = `
  uniform float uTime;
  uniform float uProgress;
  uniform float uRoot;
  uniform float uSpread;
  uniform float uStill;
  vec3 flowerCenter(float plant) {
    return mix(vec3(-1.22, 1.6, 0.0), vec3(1.26, 0.68, -0.18), plant);
  }
  vec3 plantPosition(vec3 point, float plant, float stretch) {
    vec3 center = flowerCenter(plant);
    float height = clamp((center.y - point.y) / (center.y + 4.8), 0.0, 1.0) * stretch;
    point.y += (uRoot + 4.8) * height;
    point.x += center.x * (uSpread - 1.0);
    float sway = pow(clamp((point.y - uRoot) / (center.y - uRoot), 0.0, 1.0), 1.6);
    point.x += sin(uTime * 0.66 + plant * 1.9) * 0.065 * sway * (1.0 - uStill);
    point.z += sin(uTime * 0.47 + plant * 2.0) * 0.035 * sway * (1.0 - uStill);
    return point;
  }
`;

const particleVertex = `
  ${motionShader}
  uniform float uPixelScale;
  attribute vec3 aColor;
  attribute vec4 aData;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  void main() {
    float birth = aData.x;
    float kind = aData.z;
    float plant = aData.w;
    vec3 center = flowerCenter(plant);
    float formed = smoothstep(birth, birth + 1.0, uProgress);
    vec3 target = position;
    if (kind > 1.5 && kind < 3.5) {
      vec2 petal = target.xy - center.xy;
      float turn = (1.0 - formed) * 1.35;
      target.xy = center.xy + mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * petal;
      target.z -= (1.0 - formed) * length(petal) * 0.55;
    }
    target = plantPosition(target, plant, kind < 1.5 ? 1.0 : 0.0);
    float spiral = aSeed * 6.283185 + uTime * 0.7;
    vec3 origin = vec3(center.x * uSpread + sin(spiral) * 0.25, uRoot - 0.2, sin(spiral * 1.7) * 0.5);
    vec3 point = mix(origin, target, formed);
    float flight = sin(formed * 3.141593) * (1.0 - formed);
    point.x += sin(spiral + formed * 12.0) * flight * 0.9;
    point.z += cos(spiral + formed * 9.0) * flight * 1.0;
    if (kind > 4.5) {
      float flow = fract(aSeed + uTime * (0.037 + aSeed * 0.022) * (1.0 - uStill));
      float angle = aSeed * 50.0 + flow * 12.0 + uTime * 0.18 * (1.0 - uStill);
      float reach = mix(0.12, 0.65, sin(flow * 3.141593));
      point = vec3(center.x * uSpread + sin(angle) * reach, mix(uRoot, center.y + 0.4, flow), center.z + cos(angle) * reach);
      point.x += sin(flow * 6.0 + plant * 2.0) * 0.16;
      formed = smoothstep(0.0, 0.65, uProgress) * sin(flow * 3.141593) * 0.44;
    }
    vec4 view = modelViewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = clamp(aData.y * uPixelScale * (0.45 + formed * 0.55), 1.0, 18.0);
    vAlpha = formed;
    vColor = aColor;
    vKind = kind;
  }
`;

const particleFragment = `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vKind;
  void main() {
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0 || vAlpha < 0.002) discard;
    float glow = exp(-radius * radius * 5.5);
    float pin = exp(-radius * radius * 28.0);
    float strength = vKind < 0.5 ? 0.8 : 0.54;
    gl_FragColor = vec4(vColor * (glow * 0.7 + pin * 0.65), vAlpha * strength * (1.0 - smoothstep(0.55, 1.0, radius)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const solidVertex = `
  ${motionShader}
  attribute vec3 aColor;
  attribute vec2 aData;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float formed = smoothstep(aData.x, aData.x + 0.9, uProgress);
    vec3 center = flowerCenter(aData.y);
    vec3 point = center + (position - center) * formed;
    point = plantPosition(point, aData.y, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
    vColor = aColor;
    vAlpha = formed;
  }
`;

const solidFragment = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha < 0.02) discard;
    gl_FragColor = vec4(vColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const dustVertex = `
  uniform float uTime;
  uniform float uStill;
  uniform float uPixelScale;
  uniform float uProgress;
  attribute vec3 aColor;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 point = position;
    float time = uTime * (1.0 - uStill);
    point.x += sin(time * 0.11 + aSeed * 30.0) * 0.14;
    point.y += sin(time * 0.09 + aSeed * 40.0) * 0.18;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
    gl_PointSize = clamp((0.016 + aSeed * aSeed * 0.042) * uPixelScale, 1.0, 7.0);
    vColor = aColor;
    vAlpha = (0.2 + pow(sin(time * 0.5 + aSeed * 80.0), 2.0) * 0.5) * smoothstep(0.0, 0.8, uProgress + 0.15);
  }
`;

const dustFragment = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float radius = length(gl_PointCoord - 0.5) * 2.0;
    if (radius > 1.0) discard;
    gl_FragColor = vec4(vColor, exp(-radius * radius * 7.0) * vAlpha * 0.5);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSunflowerScene(canvas, { reducedMotion = false, onPhase = () => {} } = {}) {
  const context = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  if (!context) throw new Error('This sunflower scene needs WebGL 2, which is unavailable in this browser.');
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: false, antialias: false });
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error(`Sunflower GPU shader could not initialize: ${gl.getProgramInfoLog(program) || gl.getShaderInfoLog(vertex) || gl.getShaderInfoLog(fragment) || 'unknown GPU compilation error'}`);
  };
  renderer.setClearColor(0x061712, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-4, 4, 5, -5, 0.1, 40);
  camera.position.z = 18;
  const uniforms = {
    uTime: { value: 0 }, uProgress: { value: 0 }, uRoot: { value: ROOT },
    uSpread: { value: 1 }, uStill: { value: reducedMotion ? 1 : 0 }, uPixelScale: { value: 100 },
  };
  const mobile = window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;
  const density = mobile ? 0.78 : 1;
  let randomState = 81307;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const positions = [], colors = [], data = [], seeds = [];
  const solidPositions = [], solidColors = [], solidData = [];
  const gold = [1, 0.51, 0.065];
  const sage = [0.2, 0.64, 0.32];
  const addPoint = (x, y, z, color, birth, size, kind, plant) => {
    positions.push(x, y, z);
    colors.push(...color);
    data.push(birth, size, kind, plant);
    seeds.push(random());
  };
  const addTriangle = (a, b, c, color, birth, plant) => {
    solidPositions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) {
      solidColors.push(...color);
      solidData.push(birth, plant);
    }
  };
  const addPolygon = (outline, color, birth, plant) => {
    for (let i = 1; i < outline.length - 1; i++) addTriangle(outline[0], outline[i], outline[i + 1], color, birth, plant);
  };

  FLOWERS.forEach((flower, plant) => {
    const { x, y, z, radius, core } = flower;
    // Braided filaments, rather than a filled cylinder, keep the growing stems luminous.
    for (let i = 0, count = Math.floor(2100 * density); i < count; i++) {
      const height = random();
      const twist = height * 28 + random() * Math.PI * 2;
      const width = 0.029 + (1 - height) * 0.027;
      addPoint(x + Math.sin(height * 4.8) * 0.1 + Math.cos(twist) * width,
        ROOT + (y - ROOT) * height, z - 0.12 + Math.sin(twist) * width,
        random() > 0.83 ? [0.44, 0.76, 0.24] : sage,
        0.2 + height * 1.65, 0.027 + random() * 0.024, 0, plant);
    }
    // Tapered leaves with a central vein and radiating fine ribs.
    for (let leaf = 0; leaf < 4; leaf++) {
      const side = (leaf % 2 ? 1 : -1) * (plant ? -1 : 1);
      const baseY = y - 1.5 - leaf * 0.77;
      const length = (leaf === 0 ? 0.78 : 1.02) * radius;
      for (let i = 0, count = Math.floor(620 * density); i < count; i++) {
        const along = random();
        const width = Math.pow(Math.sin(along * Math.PI), 1.15) * 0.24 * radius;
        const across = (random() * 2 - 1) * width;
        const vein = i % 5 === 0;
        addPoint(x + side * (along * length + Math.sin(along * Math.PI) * 0.08),
          baseY + along * 0.57 + (vein ? 0 : across), z - 0.13 + Math.sin(along * Math.PI) * 0.11 + across * 0.25,
          vein ? [0.48, 0.8, 0.3] : [0.065 + along * 0.06, 0.33 + along * 0.2, 0.15],
          1.35 + leaf * 0.16 + along * 0.38, vein ? 0.031 : 0.038, 1, plant);
      }
    }
    // Two offset crowns of individually pointed, subtly twisted sunflower petals.
    for (let ring = 0; ring < 2; ring++) {
      const petals = ring ? 27 : 34;
      for (let petal = 0; petal < petals; petal++) {
        const angle = petal / petals * Math.PI * 2 + ring * 0.13 + flower.tilt;
        const tip = radius * (ring ? 0.83 : 1) * (0.96 + random() * 0.08);
        const start = core * (ring ? 0.78 : 0.82);
        const bend = (random() - 0.5) * 0.16;
        for (let i = 0, count = Math.floor((ring ? 130 : 155) * density); i < count; i++) {
          const along = random();
          const width = Math.pow(Math.sin(along * Math.PI), 0.85) * (ring ? 0.095 : 0.11) * radius;
          const across = (random() * 2 - 1) * width;
          const distance = start + (tip - start) * along;
          const twist = angle + Math.sin(along * Math.PI) * bend;
          const ridge = 1 - Math.abs(across) / Math.max(width, 0.001);
          addPoint(x + Math.cos(twist) * distance - Math.sin(twist) * across,
            y + Math.sin(twist) * distance + Math.cos(twist) * across,
            z - 0.07 - ring * 0.025 + Math.sin(along * Math.PI) * 0.14 + ridge * 0.025,
            [0.87 + along * 0.13, 0.19 + along * 0.44 + ridge * 0.07, 0.014 + along * 0.065],
            2.75 + ring * 0.2 + along * 0.53 + (Math.sin(angle) + 1) * 0.16,
            0.026 + random() * 0.02, 2, plant);
        }
      }
    }
    const disk = [[x, y, z + 0.105]];
    for (let i = 0; i <= 96; i++) {
      const angle = i / 96 * Math.PI * 2;
      disk.push([x + Math.cos(angle) * core, y + Math.sin(angle) * core, z + 0.105]);
    }
    addPolygon(disk, [0.027, 0.012, 0.003], 3.2, plant);
    // Golden-angle seed packing makes an intricate, dark amber seed head, not a yellow disc.
    const seedCount = Math.floor(2550 * density);
    for (let i = 0; i < seedCount; i++) {
      const distance = Math.sqrt((i + 0.5) / seedCount) * core * 0.97;
      const angle = i * 2.399963229728653;
      const edge = distance / core;
      const light = 0.38 + random() * 0.62;
      addPoint(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance,
        z + 0.13 + Math.sqrt(Math.max(0, 1 - edge * edge)) * 0.035,
        [0.38 * light + edge * 0.13, 0.12 * light + edge * 0.08, 0.018],
        3.35 + edge * 0.45, 0.019 + random() * 0.012, 3, plant);
    }
    for (let i = 0; i < 430; i++) {
      const angle = i / 430 * Math.PI * 2;
      addPoint(x + Math.cos(angle) * core, y + Math.sin(angle) * core, z + 0.17,
        [0.87, 0.39, 0.04], 3.5, 0.025, 3, plant);
    }

    for (let i = 0, count = Math.floor(950 * density); i < count; i++) {
      addPoint(x, ROOT, z, i % 4 ? [0.3, 0.58, 0.23] : gold, 0, 0.022 + random() * 0.027, 5, plant);
    }
  });

  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  particleGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  particleGeometry.setAttribute('aData', new THREE.Float32BufferAttribute(data, 4));
  particleGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  const particleMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: particleVertex, fragmentShader: particleFragment,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.frustumCulled = false;
  particles.renderOrder = 2;
  scene.add(particles);

  const solidGeometry = new THREE.BufferGeometry();
  solidGeometry.setAttribute('position', new THREE.Float32BufferAttribute(solidPositions, 3));
  solidGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(solidColors, 3));
  solidGeometry.setAttribute('aData', new THREE.Float32BufferAttribute(solidData, 2));
  const solidMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: solidVertex, fragmentShader: solidFragment, side: THREE.DoubleSide,
  });
  const faces = new THREE.Mesh(solidGeometry, solidMaterial);
  faces.frustumCulled = false;
  scene.add(faces);

  const dustPositions = [], dustColors = [], dustSeeds = [];
  for (let i = 0, count = Math.floor(1700 * density); i < count; i++) {
    const warm = random() > 0.35;
    dustPositions.push((random() - 0.5) * 24, (random() - 0.5) * 26, -1 - random() * 8);
    dustColors.push(...(warm ? [0.68, 0.4, 0.12] : [0.14, 0.35, 0.25]));
    dustSeeds.push(random());
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.Float32BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(dustColors, 3));
  dustGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(dustSeeds, 1));
  const dustMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: dustVertex, fragmentShader: dustFragment,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 1;
  scene.add(dust);
  const releaseGPU = () => {
    particleGeometry.dispose();
    particleMaterial.dispose();
    solidGeometry.dispose();
    solidMaterial.dispose();
    dustGeometry.dispose();
    dustMaterial.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  };
  try {
    renderer.compile(scene, camera);
  } catch (error) {
    releaseGPU();
    throw error;
  }

  let disposed = false, active = false, frame = 0, lastTime = 0, elapsed = 0, motionTime = 0;
  let resolveBloom = null, phase = '';
  const settle = () => {
    if (resolveBloom) {
      const resolve = resolveBloom;
      resolveBloom = null;
      resolve();
    }
  };
  const emitPhase = next => {
    if (next !== phase) {
      phase = next;
      onPhase(next);
    }
  };
  const render = () => renderer.render(scene, camera);
  const stopFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  };
  const tick = now => {
    frame = 0;
    if (disposed || !active || document.hidden) return;
    const delta = lastTime ? (now - lastTime) / 1000 : 0;
    lastTime = now;
    motionTime += delta;
    elapsed = Math.min(DURATION, elapsed + delta);
    uniforms.uTime.value = motionTime;
    uniforms.uProgress.value = elapsed;
    if (elapsed >= DURATION) {
      emitPhase('sunshine');
      settle();
    } else if (elapsed >= 2.75) emitPhase('bloom');
    else if (elapsed >= 0.55) emitPhase('grow');
    render();
    if (active && !disposed && !document.hidden) frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (disposed) return;
    active = true;
    if (document.hidden) return;
    if (reducedMotion) render();
    else if (!frame) frame = requestAnimationFrame(tick);
  };
  const resize = () => {
    if (disposed) return;
    const bounds = (canvas.parentElement || canvas).getBoundingClientRect();
    const width = Math.max(1, bounds.width || window.innerWidth);
    const height = Math.max(1, bounds.height || window.innerHeight);
    const aspect = width / height;
    // Portrait preserves both complete crowns; landscape preserves the entire vertical silhouette.
    const worldHeight = aspect < 0.78 ? 6.5 / aspect : aspect > 1.65 ? 8.2 : 9.1;
    const worldWidth = worldHeight * aspect;
    const top = aspect < 0.78 ? 5.9 : 4.25;
    camera.left = -worldWidth / 2;
    camera.right = worldWidth / 2;
    camera.top = top;
    camera.bottom = top - worldHeight;
    camera.updateProjectionMatrix();
    uniforms.uRoot.value = camera.bottom - 0.18;
    uniforms.uSpread.value = aspect < 0.78 ? 0.9 : 1;
    const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.65 : 1.8, Math.sqrt(2400000 / (width * height)));
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    uniforms.uPixelScale.value = height * ratio / worldHeight;
    if (active && !document.hidden) render();
  };
  const visibility = () => {
    if (document.hidden) stopFrame();
    else if (active) start();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  if (observer) observer.observe(canvas.parentElement || canvas);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', visibility);
  resize();

  return {
    bloom() {
      if (disposed) return Promise.resolve();
      settle();
      stopFrame();
      elapsed = reducedMotion ? DURATION : 0;
      motionTime = 0;
      uniforms.uTime.value = 0;
      uniforms.uProgress.value = elapsed;
      phase = '';
      const promise = new Promise(resolve => { resolveBloom = resolve; });
      emitPhase(reducedMotion ? 'sunshine' : 'seed');
      start();
      if (reducedMotion) settle();
      return promise;
    },
    finish() {
      if (disposed) return;
      elapsed = DURATION;
      uniforms.uProgress.value = DURATION;
      emitPhase('sunshine');
      settle();
      start();
      if (!document.hidden) render();
    },
    idle() {
      if (disposed) return;
      elapsed = DURATION;
      uniforms.uProgress.value = DURATION;
      emitPhase('sunshine');
      settle();
      start();
    },
    pause() {
      active = false;
      stopFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      stopFrame();
      settle();
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      releaseGPU();
    },
  };
}
