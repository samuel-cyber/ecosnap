// src/lib/poolState.js
// The pool lifecycle, in one readable place. Services never write a status
// directly -- they ask this module whether a move is legal first, so an
// illegal jump (say FUNDING -> COMPLETED, skipping the risk review) is
// impossible rather than merely unlikely.

const STATES = {
  CREATED: 'CREATED',
  FUNDING: 'FUNDING',
  MOQ_REACHED: 'MOQ_REACHED',
  RISK_REVIEW: 'RISK_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SETTLEMENT: 'SETTLEMENT',
  COMPLETED: 'COMPLETED',
  REFUNDING: 'REFUNDING',
  REFUNDED: 'REFUNDED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
};

//   CREATED -> FUNDING -> MOQ_REACHED -> RISK_REVIEW -> APPROVED -> SETTLEMENT -> COMPLETED
//                                                    \-> REJECTED -> REFUNDING -> REFUNDED
//   CREATED/FUNDING -> EXPIRED -> REFUNDING -> REFUNDED
const TRANSITIONS = {
  CREATED: ['FUNDING', 'EXPIRED', 'CANCELLED'],
  FUNDING: ['MOQ_REACHED', 'EXPIRED', 'CANCELLED'],
  MOQ_REACHED: ['RISK_REVIEW'],
  // A rejected pool can be re-assessed after the supplier details are fixed,
  // so RISK_REVIEW is reachable again from REJECTED.
  RISK_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['SETTLEMENT'],
  REJECTED: ['REFUNDING', 'RISK_REVIEW'],
  // Settlement can fail at the provider; the pool goes back to APPROVED so it
  // can be retried without losing the approval that authorised it.
  SETTLEMENT: ['COMPLETED', 'APPROVED'],
  COMPLETED: [],
  REFUNDING: ['REFUNDED'],
  REFUNDED: [],
  EXPIRED: ['REFUNDING'],
  CANCELLED: ['REFUNDING'],
};

/** States in which contributions are still accepted. */
const FUNDABLE_STATES = [STATES.CREATED, STATES.FUNDING];

/** States that mean the pool is finished and will not change again. */
const TERMINAL_STATES = [STATES.COMPLETED, STATES.REFUNDED];

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function nextStates(from) {
  return TRANSITIONS[from] || [];
}

module.exports = { STATES, TRANSITIONS, FUNDABLE_STATES, TERMINAL_STATES, canTransition, nextStates };
