// src/services/risk/rules.js
//
// The trust layer, written as pure functions.
//
// Each rule receives a plain `facts` object and returns either null (nothing
// to say) or a signal explaining what it found, what that means, and the
// evidence behind it. No database, no network, no randomness -- which is why
// the same pool always produces the same assessment, and why every rule can be
// unit tested on its own.
//
// A signal never asserts fraud. It says what changed, what is missing, or what
// is unusual, and leaves the conclusion to the score and to the human reviewer.

const { similarity } = require('../../lib/nameMatch');

const ENGINE_VERSION = 'trustock-risk-rules-1.1.0';

const DISCLAIMER =
  'This is a rule-based assessment of the signals Trustock can see. It cannot ' +
  'prove that a transaction is safe, and it cannot prove that a transaction is ' +
  'fraudulent. Treat it as evidence for a human decision, not as a verdict.';

// Weight is the number of points a signal adds to (or, when negative, removes
// from) the risk score. They are deliberately blunt and readable -- a reviewer
// should be able to reconstruct the score by hand.
const WEIGHTS = {
  ACCOUNT_CHANGED_AFTER_POOL_CREATED: 40,
  ACCOUNT_CHANGED_RECENTLY: 22,
  ACCOUNT_NAME_MISMATCH: 25,
  ACCOUNT_SHARED_ACROSS_SUPPLIERS: 30,
  SUPPLIER_DETAILS_EDITED_DURING_FUNDING: 18,
  SUPPLIER_NO_HISTORY: 10,
  SUPPLIER_BRAND_NEW: 10,
  SUPPLIER_CONTACT_INCOMPLETE: 8,
  SUPPLIER_PROVEN_HISTORY: -18,
  SUPPLIER_VERIFIED: -10,
  AMOUNT_UNUSUAL_FOR_SUPPLIER: 15,
  AMOUNT_UNUSUAL_FOR_PLATFORM: 10,
  FAILED_CONTRIBUTIONS: 12,
  CONCENTRATED_FUNDING: 12,
  RAPID_FUNDING: 8,
  NEW_CREATOR: 8,
  ALL_MEMBERS_FIRST_TIME: 6,
};

const NAME_MATCH_THRESHOLD = 0.5;
const RECENT_ACCOUNT_CHANGE_DAYS = 30;
const BRAND_NEW_HOURS = 24;
const UNUSUAL_AMOUNT_MULTIPLE = 3;
const CONCENTRATION_THRESHOLD = 0.6;
const RAPID_FUNDING_MINUTES = 5;

const HIGH_THRESHOLD = 60;
const MEDIUM_THRESHOLD = 25;

// Absence of evidence is not evidence. On a young platform almost everything
// is new -- new supplier, new organiser, no settled history -- and if those
// "we cannot check this" signals stacked freely, every honest first purchase
// would be flagged and reviewers would learn to click through the warnings.
// So low-severity signals contribute at most this much in total, and a HIGH
// result additionally requires at least one high-severity finding: something
// that actually happened, not something we merely do not know.
const LOW_SEVERITY_CAP = 20;

function signal(code, { label, severity, weight, explanation, evidence = {} }) {
  return {
    code,
    label,
    status: 'flag',
    severity,
    weight,
    direction: weight >= 0 ? 'increases_risk' : 'reduces_risk',
    explanation,
    evidence,
  };
}

/**
 * A check that ran and found nothing wrong. These carry no weight, but they
 * are the difference between "we looked and it was fine" and "we did not look"
 * -- a reviewer needs to be able to tell those apart.
 */
function clear(code, { label, explanation, evidence = {} }) {
  return { code, label, status: 'clear', severity: 'clear', weight: 0, explanation, evidence };
}

const hoursBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / 36e5;
const daysBetween = (a, b) => hoursBetween(a, b) / 24;

// ---------------------------------------------------------------------------
// Supplier payout account
// ---------------------------------------------------------------------------

/**
 * The strongest signal Trustock has. Money is about to leave; if the account
 * it is going to is not the account everyone agreed to, that is worth pausing
 * for, whatever the explanation turns out to be.
 */
function accountChanged(facts) {
  const history = facts.supplierAccountHistory || [];
  if (history.length < 2) {
    return clear('ACCOUNT_UNCHANGED', {
      label: 'Payment destination unchanged since this supplier was added',
      explanation:
        'The account this pool would pay is the same one recorded when the ' +
        'supplier was first entered. Nothing has been redirected.',
      evidence: {
        account_versions: history.length,
        account_number: facts.supplier.account_number,
      },
    });
  }

  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  const changedAfterPoolCreated = new Date(latest.created_at) > new Date(facts.pool.created_at);

  const evidence = {
    changed_at: latest.created_at,
    pool_created_at: facts.pool.created_at,
    previous_account: {
      bank_name: previous.bank_name,
      account_number: previous.account_number,
      account_name: previous.account_name,
    },
    current_account: {
      bank_name: latest.bank_name,
      account_number: latest.account_number,
      account_name: latest.account_name,
    },
    total_account_versions: history.length,
  };

  if (changedAfterPoolCreated) {
    return signal('ACCOUNT_CHANGED_AFTER_POOL_CREATED', {
      label: 'Payment destination changed after this pool was created',
      severity: 'high',
      weight: WEIGHTS.ACCOUNT_CHANGED_AFTER_POOL_CREATED,
      explanation:
        'The supplier\'s payout account was changed after members had already ' +
        'agreed to fund this pool. Contributors committed to one destination ' +
        'and the money would now go to another.',
      evidence,
    });
  }

  const daysSince = daysBetween(latest.created_at, facts.now);
  if (daysSince <= RECENT_ACCOUNT_CHANGE_DAYS) {
    return signal('ACCOUNT_CHANGED_RECENTLY', {
      label: `Payment destination changed ${Math.round(daysSince)} day(s) ago`,
      severity: 'medium',
      weight: WEIGHTS.ACCOUNT_CHANGED_RECENTLY,
      explanation:
        'This supplier\'s payout account changed recently. Recent changes are ' +
        'often legitimate, but they are also the most common step in a ' +
        'redirected-payment attempt, so they are worth confirming directly.',
      evidence: { ...evidence, days_since_change: Math.round(daysSince) },
    });
  }

  return clear('ACCOUNT_STABLE', {
    label: `Payment destination last changed ${Math.round(daysSince)} days ago`,
    explanation:
      'This supplier\'s payout account has changed in the past, but not ' +
      'recently and not during this pool.',
    evidence: { ...evidence, days_since_change: Math.round(daysSince) },
  });
}

/** The name on the account should look like the business being paid. */
function accountNameMismatch(facts) {
  const { supplier } = facts;
  const score = similarity(supplier.name, supplier.account_name);
  if (score >= NAME_MATCH_THRESHOLD) {
    return clear('ACCOUNT_NAME_CONSISTENT', {
      label: 'Account name matches the supplier name',
      explanation: 'The destination account is held in a name consistent with the supplier being paid.',
      evidence: {
        supplier_name: supplier.name,
        account_name: supplier.account_name,
        name_similarity: Number(score.toFixed(2)),
      },
    });
  }

  return signal('ACCOUNT_NAME_MISMATCH', {
    label: 'Account name does not match the supplier name',
    severity: 'high',
    weight: WEIGHTS.ACCOUNT_NAME_MISMATCH,
    explanation:
      'The name on the destination bank account does not clearly correspond to ' +
      'the supplier the pool is buying from. This can be a trading name or a ' +
      'director\'s personal account, but it should be confirmed before payout.',
    evidence: {
      supplier_name: supplier.name,
      account_name: supplier.account_name,
      name_similarity: Number(score.toFixed(2)),
      threshold: NAME_MATCH_THRESHOLD,
    },
  });
}

/** One bank account standing behind several different supplier records. */
function accountSharedAcrossSuppliers(facts) {
  if (!facts.suppliersSharingAccount || facts.suppliersSharingAccount.length === 0) {
    return clear('ACCOUNT_NOT_SHARED', {
      label: 'This bank account is not registered to any other supplier',
      explanation: 'No other supplier record on Trustock points at the same destination account.',
      evidence: { account_number: facts.supplier.account_number },
    });
  }

  return signal('ACCOUNT_SHARED_ACROSS_SUPPLIERS', {
    label: 'This bank account is registered to more than one supplier',
    severity: 'high',
    weight: WEIGHTS.ACCOUNT_SHARED_ACROSS_SUPPLIERS,
    explanation:
      'The same destination account appears under other supplier names on ' +
      'Trustock. Legitimate groups do share accounts, but so does one person ' +
      'operating under several supplier identities.',
    evidence: {
      account_number: facts.supplier.account_number,
      other_supplier_names: facts.suppliersSharingAccount.map((s) => s.name),
    },
  });
}

/** Any edit to the supplier record while members were paying in. */
function supplierEditedDuringFunding(facts) {
  const allEdits = facts.supplierEditsDuringFunding || [];
  // Payout-account changes are reported by accountChanged(). Claiming "details
  // were not edited" while that rule is flagging a changed account would be a
  // contradiction, so this rule stands down instead.
  const accountAlreadyFlagged = allEdits.some((e) => e.action === 'supplier.account_changed');
  const edits = allEdits.filter((entry) => entry.action !== 'supplier.account_changed');

  if (edits.length === 0) {
    if (accountAlreadyFlagged) return null;
    return clear('SUPPLIER_DETAILS_STABLE', {
      label: 'Supplier details were not edited during funding',
      explanation: 'The supplier record is the same one members saw when they paid in.',
      evidence: { edits_since_pool_created: 0 },
    });
  }

  return signal('SUPPLIER_DETAILS_EDITED_DURING_FUNDING', {
    label: 'Supplier details were edited while the pool was being funded',
    severity: 'medium',
    weight: WEIGHTS.SUPPLIER_DETAILS_EDITED_DURING_FUNDING,
    explanation:
      'The supplier record changed between the pool opening and the money being ' +
      'collected. Contributors may have agreed to different details from the ' +
      'ones now on file.',
    evidence: { edits: edits.map((e) => ({ action: e.action, at: e.created_at })) },
  });
}

// ---------------------------------------------------------------------------
// Supplier standing
// ---------------------------------------------------------------------------

function supplierHistory(facts) {
  const completed = facts.supplierCompletedSettlements || 0;

  if (completed > 0) {
    return signal('SUPPLIER_PROVEN_HISTORY', {
      label: `Supplier has ${completed} completed settlement(s) on Trustock`,
      severity: 'info',
      weight: WEIGHTS.SUPPLIER_PROVEN_HISTORY,
      explanation:
        'This supplier has been paid through Trustock before without the ' +
        'transaction being reversed, which is a point in their favour.',
      evidence: { completed_settlements: completed },
    });
  }

  return signal('SUPPLIER_NO_HISTORY', {
    label: 'External supplier with no completed Trustock history',
    severity: 'low',
    weight: WEIGHTS.SUPPLIER_NO_HISTORY,
    explanation:
      'This supplier was added by a buyer and has never completed a settlement ' +
      'on Trustock, so there is nothing to compare this transaction against. ' +
      'That is normal for a first purchase -- it is an absence of evidence, ' +
      'not evidence of a problem.',
    evidence: { verification_status: facts.supplier.verification_status, completed_settlements: 0 },
  });
}

function supplierVerified(facts) {
  if (facts.supplier.verification_status !== 'verified') return null;
  return signal('SUPPLIER_VERIFIED', {
    label: 'Supplier is verified on Trustock',
    severity: 'info',
    weight: WEIGHTS.SUPPLIER_VERIFIED,
    explanation: 'This supplier holds a Trustock account with a settled transaction history.',
    evidence: { verification_status: 'verified' },
  });
}

function supplierBrandNew(facts) {
  const age = hoursBetween(facts.supplier.created_at, facts.pool.created_at);
  if (age > BRAND_NEW_HOURS) {
    return clear('SUPPLIER_ESTABLISHED_RECORD', {
      label: `Supplier was on file ${Math.round(age / 24)} day(s) before this pool opened`,
      explanation: 'The supplier record was not created to serve this particular transaction.',
      evidence: { supplier_created_at: facts.supplier.created_at, days_before_pool: Math.round(age / 24) },
    });
  }

  return signal('SUPPLIER_BRAND_NEW', {
    label: 'Supplier record was created just before this pool',
    severity: 'low',
    weight: WEIGHTS.SUPPLIER_BRAND_NEW,
    explanation:
      'The supplier was added to Trustock within a day of this pool being ' +
      'created. Common for a genuine first purchase, and also what a ' +
      'throwaway supplier record looks like.',
    evidence: {
      supplier_created_at: facts.supplier.created_at,
      hours_before_pool: Number(age.toFixed(1)),
    },
  });
}

function supplierContactIncomplete(facts) {
  const missing = [];
  if (!facts.supplier.phone) missing.push('phone');
  if (!facts.supplier.email) missing.push('email');
  if (missing.length === 0) {
    return clear('SUPPLIER_CONTACT_ON_FILE', {
      label: 'Supplier has a phone number and email on file',
      explanation: 'There is an independent way to confirm the payout details before money leaves.',
      evidence: { phone: facts.supplier.phone, email: facts.supplier.email },
    });
  }

  return signal('SUPPLIER_CONTACT_INCOMPLETE', {
    label: `Supplier has no ${missing.join(' or ')} on file`,
    severity: 'low',
    weight: WEIGHTS.SUPPLIER_CONTACT_INCOMPLETE,
    explanation:
      'There is no independent way to reach this supplier to confirm the ' +
      'payout details before the money leaves.',
    evidence: { missing_fields: missing },
  });
}

// ---------------------------------------------------------------------------
// Transaction shape
// ---------------------------------------------------------------------------

function amountUnusual(facts) {
  const target = Number(facts.pool.target_amount_kobo);
  const supplierAverage = facts.supplierAveragePoolKobo;
  const platformAverage = facts.platformAveragePoolKobo;

  if (supplierAverage && target > supplierAverage * UNUSUAL_AMOUNT_MULTIPLE) {
    return signal('AMOUNT_UNUSUAL_FOR_SUPPLIER', {
      label: 'Transaction is much larger than this supplier\'s usual size',
      severity: 'medium',
      weight: WEIGHTS.AMOUNT_UNUSUAL_FOR_SUPPLIER,
      explanation:
        'This pool is several times larger than previous pools paid to this ' +
        'supplier. A sudden jump in value is worth a second look, because it ' +
        'is where a redirected payment does the most damage.',
      evidence: {
        pool_amount_kobo: target,
        supplier_average_kobo: Math.round(supplierAverage),
        multiple: Number((target / supplierAverage).toFixed(1)),
      },
    });
  }

  if (platformAverage && target > platformAverage * UNUSUAL_AMOUNT_MULTIPLE) {
    return signal('AMOUNT_UNUSUAL_FOR_PLATFORM', {
      label: 'Transaction is much larger than a typical Trustock pool',
      severity: 'low',
      weight: WEIGHTS.AMOUNT_UNUSUAL_FOR_PLATFORM,
      explanation:
        'This pool is several times the size of an average pool on the ' +
        'platform. Larger transactions deserve proportionally more care.',
      evidence: {
        pool_amount_kobo: target,
        platform_average_kobo: Math.round(platformAverage),
        multiple: Number((target / platformAverage).toFixed(1)),
      },
    });
  }

  if (!supplierAverage && !platformAverage) return null; // nothing to compare against

  return clear('AMOUNT_IN_LINE', {
    label: 'Transaction size is in line with previous pools',
    explanation: 'This pool is a normal size next to what has settled on Trustock before.',
    evidence: {
      pool_amount_kobo: target,
      supplier_average_kobo: supplierAverage ? Math.round(supplierAverage) : null,
      platform_average_kobo: platformAverage ? Math.round(platformAverage) : null,
    },
  });
}

function failedContributions(facts) {
  const failed = facts.failedContributionCount || 0;
  if (failed < 2) {
    return clear('CONTRIBUTIONS_CLEAN', {
      label: failed === 0
        ? 'Every contribution went through first time'
        : 'Only one contribution attempt failed',
      explanation: 'Payments into this pool behaved normally.',
      evidence: { failed_attempts: failed, successful_contributions: facts.paidContributionCount },
    });
  }

  return signal('FAILED_CONTRIBUTIONS', {
    label: `${failed} contribution attempt(s) failed on this pool`,
    severity: 'medium',
    weight: WEIGHTS.FAILED_CONTRIBUTIONS,
    explanation:
      'Repeated failed payment attempts can mean an ordinary bank problem, or ' +
      'they can mean payment details that do not work as described.',
    evidence: { failed_attempts: failed, successful_contributions: facts.paidContributionCount },
  });
}

/**
 * The pool says "five people, fifty thousand each" but one account funded most
 * of it -- so the group buying story and the money movement disagree.
 */
function concentratedFunding(facts) {
  const target = Number(facts.pool.target_amount_kobo);
  const largest = facts.largestContributorPaidKobo || 0;
  if (target === 0 || facts.paidContributionCount < 2) return null;

  const share = largest / target;
  if (share <= CONCENTRATION_THRESHOLD) {
    return clear('FUNDING_EVENLY_SPREAD', {
      label: 'Contributions are spread across the members as agreed',
      explanation: 'The money came in the way the pool was described: several members, similar shares.',
      evidence: {
        largest_contributor_share: Number(share.toFixed(2)),
        contributors: facts.paidContributionCount,
      },
    });
  }

  return signal('CONCENTRATED_FUNDING', {
    label: 'One member funded most of this pool',
    severity: 'medium',
    weight: WEIGHTS.CONCENTRATED_FUNDING,
    explanation:
      'The pool was set up as an even split, but a single member paid the ' +
      'large majority of it. The transaction is not behaving like the group ' +
      'purchase it was described as.',
    evidence: {
      largest_contributor_share: Number(share.toFixed(2)),
      threshold: CONCENTRATION_THRESHOLD,
      largest_contribution_kobo: largest,
    },
  });
}

function rapidFunding(facts) {
  if (facts.paidContributionCount < 3 || !facts.fundingWindowMinutes) return null;
  if (facts.fundingWindowMinutes > RAPID_FUNDING_MINUTES) {
    return clear('FUNDING_PACE_NORMAL', {
      label: 'Contributions arrived at a normal pace',
      explanation: 'Members paid in over hours or days, not all within a few minutes of each other.',
      evidence: { funding_window_minutes: Math.round(facts.fundingWindowMinutes) },
    });
  }

  return signal('RAPID_FUNDING', {
    label: 'Pool was funded unusually quickly',
    severity: 'low',
    weight: WEIGHTS.RAPID_FUNDING,
    explanation:
      'Every contribution arrived within a few minutes of the first. Often ' +
      'just an organised group, but it is also how coordinated accounts behave.',
    evidence: {
      funding_window_minutes: Number(facts.fundingWindowMinutes.toFixed(1)),
      contributions: facts.paidContributionCount,
    },
  });
}

function newCreator(facts) {
  const age = hoursBetween(facts.creator.created_at, facts.pool.created_at);
  if (age > BRAND_NEW_HOURS) {
    return clear('CREATOR_ESTABLISHED', {
      label: `Organiser's account was ${Math.round(age / 24)} day(s) old when this pool opened`,
      explanation: 'The pool was not created by an account registered moments earlier.',
      evidence: { creator_created_at: facts.creator.created_at },
    });
  }

  return signal('NEW_CREATOR', {
    label: 'Pool creator registered within a day of creating it',
    severity: 'low',
    weight: WEIGHTS.NEW_CREATOR,
    explanation:
      'The organiser\'s Trustock account is new, so there is no track record ' +
      'behind the pool yet.',
    evidence: { creator_created_at: facts.creator.created_at, hours_before_pool: Number(age.toFixed(1)) },
  });
}

function allMembersFirstTime(facts) {
  if (!facts.memberCount || facts.membersWithCompletedPools === undefined) return null;
  if (facts.membersWithCompletedPools > 0) {
    return clear('MEMBERS_HAVE_HISTORY', {
      label: `${facts.membersWithCompletedPools} of ${facts.memberCount} members have completed a pool before`,
      explanation: 'This group is not transacting on Trustock for the first time.',
      evidence: {
        member_count: facts.memberCount,
        members_with_completed_pools: facts.membersWithCompletedPools,
      },
    });
  }

  return signal('ALL_MEMBERS_FIRST_TIME', {
    label: 'No member of this pool has completed one before',
    severity: 'low',
    weight: WEIGHTS.ALL_MEMBERS_FIRST_TIME,
    explanation:
      'Everyone in this pool is transacting on Trustock for the first time, so ' +
      'there is no behavioural history to compare against.',
    evidence: { member_count: facts.memberCount, members_with_completed_pools: 0 },
  });
}

const RULES = [
  accountChanged,
  accountNameMismatch,
  accountSharedAcrossSuppliers,
  supplierEditedDuringFunding,
  supplierHistory,
  supplierVerified,
  supplierBrandNew,
  supplierContactIncomplete,
  amountUnusual,
  failedContributions,
  concentratedFunding,
  rapidFunding,
  newCreator,
  allMembersFirstTime,
];

function levelFor(score) {
  if (score >= HIGH_THRESHOLD) return 'HIGH';
  if (score >= MEDIUM_THRESHOLD) return 'MEDIUM';
  return 'LOW';
}

/**
 * Runs every rule and turns the signals into a score, a level and a decision.
 * Only a LOW result clears itself; anything else pauses the payout for a human.
 */
function evaluate(facts) {
  const results = [];
  for (const rule of RULES) {
    const result = rule(facts);
    if (result) results.push(result);
  }

  // Flags move the score. Clears do not, but they are reported, because a
  // reviewer deserves to see what was checked and found sound.
  const signals = results.filter((r) => r.status === 'flag');
  const checksPassed = results.filter((r) => r.status === 'clear');

  const sumOf = (predicate) => signals.filter(predicate).reduce((total, s) => total + s.weight, 0);

  const substantiated = sumOf((s) => s.weight > 0 && ['high', 'medium'].includes(s.severity));
  const unknowns = sumOf((s) => s.weight > 0 && !['high', 'medium'].includes(s.severity));
  const unknownsCounted = Math.min(unknowns, LOW_SEVERITY_CAP);
  const reducing = sumOf((s) => s.weight < 0);

  const rawScore = substantiated + unknownsCounted + reducing;
  const score = Math.max(0, Math.min(100, rawScore));

  let level = levelFor(score);
  let levelNote = null;

  // A HIGH result has to be earned by a substantiated finding.
  if (level === 'HIGH' && !signals.some((s) => s.severity === 'high')) {
    level = 'MEDIUM';
    levelNote =
      'Held at MEDIUM: the score comes from things Trustock could not verify ' +
      'rather than from any single high-severity finding.';
  }

  return {
    score,
    raw_score: rawScore,
    level,
    level_note: levelNote,
    decision: level === 'LOW' ? 'AUTO_APPROVE' : 'REVIEW_REQUIRED',
    // The arithmetic, spelled out, so a reviewer can reproduce the score.
    scoring: {
      substantiated_weight: substantiated,
      unverifiable_weight: unknowns,
      unverifiable_weight_counted: unknownsCounted,
      unverifiable_weight_cap: LOW_SEVERITY_CAP,
      reducing_weight: reducing,
      total: score,
    },
    signals: signals.sort((a, b) => b.weight - a.weight),
    checks_passed: checksPassed,
    checks_run: RULES.length,
    engine_version: ENGINE_VERSION,
    thresholds: { medium: MEDIUM_THRESHOLD, high: HIGH_THRESHOLD },
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  evaluate,
  levelFor,
  LOW_SEVERITY_CAP,
  RULES,
  WEIGHTS,
  ENGINE_VERSION,
  DISCLAIMER,
  HIGH_THRESHOLD,
  MEDIUM_THRESHOLD,
};
