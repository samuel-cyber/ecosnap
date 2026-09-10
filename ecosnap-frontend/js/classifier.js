/* classifier.js
 *
 * Runs the PM's Teachable Machine model in the browser via TensorFlow.js
 * (report section 1.3 step 3) and turns its output into the ai_label /
 * ai_confidence pair the backend expects.
 *
 * Two things this file is deliberately strict about:
 *
 * 1. It never invents a prediction. If the model is not configured, it says
 *    so and the UI offers a clearly-labelled manual override instead. A demo
 *    that silently fakes inference is worse than one that admits the model
 *    isn't wired up yet.
 *
 * 2. The model has THREE classes (burning, blocked_drain, and a none/
 *    irrelevant class -- report section 2.2) but the backend only accepts two
 *    categories. A top prediction of "none" must therefore block submission,
 *    not get coerced into one of the real categories.
 */

import { config, hasModel } from './config.js';

export const CATEGORIES = ['burning', 'blocked_drain'];

let model = null;
let loadPromise = null;

/**
 * Maps a Teachable Machine class name onto a backend category.
 * Tolerates the spacing/casing people actually type into Teachable Machine
 * ("Blocked Drain", "blocked-drain", "Burning") so a cosmetic naming choice
 * in the model doesn't break submission.
 */
export function normaliseClassName(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

  // The explicit "not a hazard" class is tested first, so a label like
  // "none_irrelevant" can never be caught by a hazard keyword below.
  if (/(^|_)(none|nothing|other|irrelevant|neither|background|clean)(_|$)/.test(key)) {
    return 'none';
  }

  // Keyword match, not an exact list. The trained model names its classes
  // "burning_refuse" and "blocked_drainages"; an exact list sent both to
  // "none", which the UI reads as "that isn't a hazard" and blocks every
  // submission. Matching on the stem survives the next rename too.
  if (/burn|fire|smoke/.test(key)) return 'burning';
  if (/drain|gutter|sewer/.test(key)) return 'blocked_drain';
  return 'none';
}

/** Loads the model once. Resolves to null when no model URL is configured. */
export async function load() {
  if (!hasModel()) return null;
  if (model) return model;

  if (!window.tmImage) {
    throw new Error(
      'The TensorFlow.js / Teachable Machine library did not load — check your connection.'
    );
  }

  if (!loadPromise) {
    const base = config.TM_MODEL_URL.replace(/\/$/, '');
    loadPromise = window.tmImage
      .load(`${base}/model.json`, `${base}/metadata.json`)
      .then((loaded) => {
        model = loaded;
        return loaded;
      })
      .catch((error) => {
        loadPromise = null;
        throw new Error(`Could not load the Teachable Machine model: ${error.message}`);
      });
  }
  return loadPromise;
}

/**
 * Classifies an <img> element.
 *
 * Returns { available, label, category, confidence, predictions } where
 * `available: false` means no model is configured and the caller must ask the
 * user to choose a category manually.
 */
export async function classify(imageElement) {
  if (!hasModel()) {
    return { available: false, reason: 'no_model', predictions: [] };
  }

  const loaded = await load();
  const raw = await loaded.predict(imageElement);

  const predictions = raw
    .map((p) => ({
      className: p.className,
      category: normaliseClassName(p.className),
      probability: p.probability,
    }))
    .sort((a, b) => b.probability - a.probability);

  const top = predictions[0];

  return {
    available: true,
    label: top.className,
    category: top.category,
    // Already 0..1 from TF.js — the backend rejects percentages, so it must
    // stay in this range all the way through.
    confidence: top.probability,
    predictions,
  };
}

/** True when the model's best guess is the none/irrelevant class. */
export const isIrrelevant = (result) => result.available && result.category === 'none';

/** True when the backend is likely to flag this rather than verify it. */
export const willLikelyFlag = (confidence) => confidence < config.CONFIDENCE_THRESHOLD;
