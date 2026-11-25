/* Starting values for the free AI allowance and purchased calls. The owner changes them on the Costs tab. */
export const ALLOWANCE_DEFAULTS = {
  freePerLead: 3, callPriceCents: 200, minCalls: 5,
  budgetLearn: 8, budgetPractice: 6, budgetExam: 16,
  dailyRoleplay: 15, dailyDrill: 8, dailyPractice: 2, dailyExamTele: 2, dailyExamZoom: 2,
  examTeleCalls: 1, examZoomCalls: 3, learnPackReps: 10,
  // what one free start is counted as (kept on the high side so the real cost stays under budget)
  estRoleplay: 0.15, estDrill: 0.25, estDial: 0.4, estCall: 1.2, estExamTele: 1.5, estExamZoom: 6
};
/* Bump when the starting values change, so older saved settings don't override the new plan. */
export const ALLOWANCE_VERSION = 2;
