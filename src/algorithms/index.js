/**
 * Algorithm registry. Add a new strategy by dropping a module here that
 * implements { name, create, consume, peek } and registering it below.
 */

import { tokenBucket } from './tokenBucket.js';
import { slidingWindow } from './slidingWindow.js';

export const algorithms = {
  [tokenBucket.name]: tokenBucket,
  [slidingWindow.name]: slidingWindow,
};

export const DEFAULT_ALGORITHM = tokenBucket.name;

export function getAlgorithm(name) {
  return algorithms[name] || algorithms[DEFAULT_ALGORITHM];
}
