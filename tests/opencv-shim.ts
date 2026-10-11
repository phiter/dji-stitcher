// Node cannot import the OpenCV.js UMD bundle as an ES module (its export is a thenable), so load it via require.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default require('@techstark/opencv-js');
