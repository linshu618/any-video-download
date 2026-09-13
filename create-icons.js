// Regenerate extension icons from the approved source: npm run icons
import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
const source = fileURLToPath(new URL('./icons/icon-source.png', import.meta.url));
for (const size of [16, 32, 48, 128]) {
  const output = fileURLToPath(new URL(`./icons/icon${size}.png`, import.meta.url));
  await sharp(source).resize(size, size, {fit: 'contain'}).png().toFile(output);
  console.log(`Generated icon${size}.png`);
}
