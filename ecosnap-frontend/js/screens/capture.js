/* screens/capture.js
 *
 * Steps 2-4 of the build order in one flow: capture a photo, classify it in
 * the browser, upload it, submit the report -- then show a result screen that
 * treats "flagged" as a normal outcome rather than an error (report 1.2/1.4).
 */

import { config, hasModel } from '../config.js';
import * as api from '../api.js';
import { icon } from '../icons.js';
import * as auth from '../auth.js';
import * as classifier from '../classifier.js';
import { uploadPhoto } from '../storage.js';
import {
  render, $, toast, withBusy, esc, getPosition, CATEGORY_LABELS, categoryIcon,
} from '../ui.js';

// Everything the current capture knows about itself.
let draft = null;

/** Object URLs are held by the page until revoked; drop the previous one. */
function releaseDraft() {
  if (draft && draft.objectUrl) URL.revokeObjectURL(draft.objectUrl);
}

export function show() {
  releaseDraft();
  draft = null;
  render(`
    <div class="page-head">
      <h1>Report a hazard</h1>
      <p>Point your camera at burning trash or a blocked drain and take one clear photo.</p>
    </div>

    <label class="capture-drop" for="photo">
      ${icon('camera', { size: 34 })}
      <h2>Take a photo</h2>
      <p>Get close enough that the problem fills most of the frame.</p>
    </label>
    <input id="photo" type="file" accept="image/*" capture="environment" hidden />

    <div class="card mt">
      <h3>What counts as a report?</h3>
      <div class="mt">
        <div class="hazard-row" data-cat="burning">
          ${categoryIcon('burning')}
          <span><b>Burning trash</b> — open waste fires, smoke</span>
        </div>
        <div class="hazard-row" data-cat="blocked_drain">
          ${categoryIcon('blocked_drain')}
          <span><b>Blocked drain</b> — clogged gutters, standing water</span>
        </div>
      </div>
      <p class="hint mt">Anything else will be rejected before it's submitted.</p>
    </div>`);

  $('#photo').onchange = (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) analyze(file);
  };
}

/** Renders the "Analyzing…" state, then runs inference on the loaded image. */
async function analyze(file) {
  releaseDraft();
  const objectUrl = URL.createObjectURL(file);

  render(`
    <div class="preview"><img id="shot" src="${objectUrl}" alt="Your photo" /></div>
    <div class="card mt analyzing">
      <div class="spinner"></div>
      <h2>Analyzing…</h2>
      <p>${hasModel() ? 'Running the model on your device.' : 'Checking your photo.'}</p>
    </div>`);

  const image = $('#shot');
  await new Promise((resolve) => {
    if (image.complete) return resolve();
    image.onload = resolve;
    image.onerror = resolve;
  });

  // Kick off the location lookup alongside inference; neither blocks the other.
  const positionPromise = getPosition();

  let result;
  try {
    result = await classifier.classify(image);
  } catch (error) {
    toast(error.message, 'bad');
    result = { available: false, reason: 'error', predictions: [] };
  }

  const position = await positionPromise;

  draft = {
    file,
    objectUrl,
    position,
    category: result.available && result.category !== 'none' ? result.category : null,
    aiLabel: result.available ? result.label : null,
    aiConfidence: result.available ? result.confidence : null,
    modelUsed: result.available,
  };

  showReview(result);
}

function predictionRows(result) {
  return result.predictions
    .map((p, index) => `
      <div class="pred-row ${index === 0 ? 'top' : ''}">
        <span>${esc(p.className)}</span>
        <span class="pred-pct">${(p.probability * 100).toFixed(1)}%</span>
        <div class="pred-bar"><span style="width:${(p.probability * 100).toFixed(1)}%"></span></div>
      </div>`)
    .join('');
}

/**
 * Location, and a way out when there isn't one. A denied or unavailable GPS
 * fix used to disable Submit permanently, which dead-ends the only flow the
 * app has -- on desktop, over plain http, or after one accidental "Block",
 * the hazard simply could not be reported. Falling back to the neighborhood
 * centre keeps the report filable, and says plainly that it is approximate.
 */
function locationCard() {
  if (draft.position) {
    const place = `${draft.position.lat.toFixed(4)}, ${draft.position.lng.toFixed(4)}`;
    return `
      <div class="card mt">
        <h3>Location</h3>
        <p class="small muted mt">${icon('pin', { size: 15 })} ${esc(place)}</p>
        ${draft.approxLabel ? `
          <p class="hint mt">
            Approximate — the centre of ${esc(draft.approxLabel)}, because your device
            didn't share a GPS fix.
          </p>` : ''}
      </div>`;
  }

  return `
    <div class="card mt">
      <h3>Location</h3>
      <p class="small muted mt">
        ${icon('alert', { size: 15 })} Your device didn't share a location.
      </p>
      <div class="actions mt">
        <button class="btn btn-quiet" id="geo-retry">Try again</button>
        <button class="btn btn-quiet" id="geo-approx">Use ${esc(fallbackArea())} centre</button>
      </div>
      <p class="hint mt">
        A GPS fix pins the report exactly where you're standing. The neighborhood centre
        is approximate, but the report still counts toward ${esc(fallbackArea())}.
      </p>
    </div>`;
}

/** The signed-in user's neighborhood when we have a centre for it, else Yaba. */
function fallbackArea() {
  const hood = (auth.getUser() || {}).neighborhood;
  return hood && config.NEIGHBORHOOD_CENTERS[hood] ? hood : 'Yaba';
}

/** The confirm-before-submit screen. */
function showReview(result) {
  const irrelevant = classifier.isIrrelevant(result);
  const lowConfidence =
    result.available && !irrelevant && classifier.willLikelyFlag(result.confidence);

  let body;

  if (irrelevant) {
    // Three-class model doing its job: this isn't a hazard, so don't submit it.
    body = `
      <div class="notice">
        <b>That doesn't look like a hazard.</b> The model's best guess was
        “${esc(result.label)}”. Take a photo of burning trash or a blocked drain.
      </div>
      <div class="card">
        <h3>What the model saw</h3>
        <div class="prediction">${predictionRows(result)}</div>
      </div>
      <div class="actions mt">
        <button class="btn btn-primary" id="retake">Take another photo</button>
      </div>`;
  } else if (result.available) {
    body = `
      <div class="card">
        <div class="row-between">
          <h2>${categoryIcon(draft.category, 22)} ${esc(CATEGORY_LABELS[draft.category])}</h2>
          <span class="pill ${lowConfidence ? 'pill-warn' : 'pill-green'}">
            ${(result.confidence * 100).toFixed(0)}% confident
          </span>
        </div>
        <div class="prediction mt">${predictionRows(result)}</div>
        ${lowConfidence ? `
          <div class="notice mt">
            Confidence is below ${config.CONFIDENCE_THRESHOLD * 100}%, so this will probably be
            held for review rather than earning points straight away. You can still submit it.
          </div>` : ''}
      </div>`;
  } else {
    // No model configured — say so, and let the user classify manually rather
    // than inventing a confidence score.
    body = `
      <div class="notice">
        <b>No AI model is configured yet.</b> Add the exported Teachable Machine URL as
        <code>TM_MODEL_URL</code> to enable automatic classification. For now, choose the
        category yourself — it will be submitted as a manual classification.
      </div>
      <div class="card">
        <h3>What are you reporting?</h3>
        <div class="category-pick mt">
          ${['burning', 'blocked_drain'].map((c) => `
            <button class="cat-btn" data-cat="${c}">
              ${categoryIcon(c, 22)}${esc(CATEGORY_LABELS[c])}
            </button>`).join('')}
        </div>
      </div>`;
  }

  render(`
    <div class="preview"><img src="${draft.objectUrl}" alt="Your photo" /></div>
    <div class="mt">${body}</div>

    ${irrelevant ? '' : `
      ${locationCard()}

      <div class="actions mt">
        <button class="btn btn-ghost" id="retake">Retake</button>
        <button class="btn btn-primary" id="submit" ${!draft.position ? 'disabled' : ''}>
          Submit report
        </button>
      </div>`}`);

  const retake = $('#retake');
  if (retake) retake.onclick = show;

  bindCategoryButtons();

  const geoRetry = $('#geo-retry');
  if (geoRetry) {
    geoRetry.onclick = () =>
      withBusy(geoRetry, async () => {
        const position = await getPosition();
        if (!position) {
          return toast('Still no location — use the neighborhood centre instead.', 'bad');
        }
        draft.position = position;
        draft.approxLabel = null;
        showReview(result);
      });
  }

  const geoApprox = $('#geo-approx');
  if (geoApprox) {
    geoApprox.onclick = () => {
      const area = fallbackArea();
      draft.position = config.NEIGHBORHOOD_CENTERS[area] || config.DEFAULT_CENTER;
      draft.approxLabel = area;
      showReview(result);
    };
  }

  const submit = $('#submit');
  if (submit) {
    submit.onclick = () => {
      if (!draft.category) return toast('Choose a category first.', 'bad');
      return withBusy(submit, doSubmit).catch((error) => toast(error.message, 'bad'));
    };
  }
}

function bindCategoryButtons() {
  document.querySelectorAll('.cat-btn').forEach((button) => {
    button.onclick = () => {
      document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('selected'));
      button.classList.add('selected');
      draft.category = button.dataset.cat;
      draft.aiLabel = `manual:${button.dataset.cat}`;
      // A human's choice is recorded at full confidence, and labelled as
      // manual so the data never pretends the model made this call.
      draft.aiConfidence = 1;
    };
  });
}

/** Upload the photo, then submit the report. */
async function doSubmit() {
  const user = auth.getUser();

  const upload = await uploadPhoto(draft.file, user.id);
  if (upload.simulated) toast(upload.notice, 'bad');

  const report = await api.createReport({
    userId: user.id,
    imageUrl: upload.url,
    category: draft.category,
    lat: draft.position.lat,
    lng: draft.position.lng,
    aiLabel: draft.aiLabel,
    aiConfidence: draft.aiConfidence,
  });

  await auth.refresh();
  showResult(report);
}

/**
 * The two outcomes, deliberately different in tone. "flagged" is a normal
 * result -- low confidence or a suspected duplicate -- not a failure.
 */
function showResult(report) {
  const verified = report.status === 'verified';

  render(`
    <div class="result ${verified ? 'verified' : 'flagged'}">
      <div class="state-icon">${verified ? icon('check', { size: 32 }) : icon('clock', { size: 32 })}</div>
      <h1>${verified ? 'Report verified!' : "Thanks — we're double-checking this one"}</h1>
      ${verified
        ? `<div class="points-pop">
             <span class="points-pop-n">+${report.points_awarded}</span>
             <span class="points-pop-u">EcoPoints</span>
           </div>
           <p>Your report is live on the map${report.neighborhood && report.neighborhood !== 'Unknown'
              ? ` and counted toward <b>${esc(report.neighborhood)}</b>` : ''}.</p>`
        : `<p>This one needs a second look — either the photo wasn't clear enough to classify
             confidently, or someone may have already reported this spot recently.
             No points this time, but it still helps.</p>`}
    </div>

    <div class="card">
      <div class="rank flush">
        <span class="rank-name">Status</span>
        <span class="pill ${verified ? 'pill-green' : 'pill-warn'}">${esc(report.status)}</span>
      </div>
      <div class="rank">
        <span class="rank-name">Neighborhood</span>
        <span class="rank-pts">${esc(report.neighborhood || 'Unknown')}</span>
      </div>
      <div class="rank">
        <span class="rank-name">Points awarded</span>
        <span class="rank-pts">${report.points_awarded}</span>
      </div>
    </div>

    <div class="actions mt">
      <button class="btn btn-quiet" id="again">Report another</button>
      <a class="btn btn-primary" href="#/map">See the map</a>
    </div>`);

  $('#again').onclick = show;
}
