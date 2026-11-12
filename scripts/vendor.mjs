import { copyFileSync, mkdirSync } from 'node:fs';

const destination = new URL('../public/vendor/three-0.181.0/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const name of ['three.module.min.js', 'three.core.min.js']) {
  copyFileSync(new URL(`../node_modules/three/build/${name}`, import.meta.url), new URL(name, destination));
}
copyFileSync(new URL('../node_modules/three/LICENSE', import.meta.url), new URL('LICENSE.txt', destination));
