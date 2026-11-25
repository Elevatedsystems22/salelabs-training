/* Starting values for the free AI allowance and purchased calls. The owner changes them on the Costs tab. */
export const ALLOWANCE_DEFAULTS = {
  freePerLead: 3, callPriceCents: 200, minCalls: 5,
  budgetLearn: 12, budgetPractice: 13, budgetExam: 25,
  dailyRoleplay: 20, dailyDrill: 15, dailyPractice: 3, dailyExamTele: 2, dailyExamZoom: 2,
  examTeleCalls: 1, examZoomCalls: 3, learnPackReps: 10,
  // what one free start is counted as (kept on the high side so the real cost stays under budget)
  estRoleplay: 0.15, estDrill: 0.25, estDial: 0.4, estCall: 1.2, estExamTele: 1.5, estExamZoom: 6
};
