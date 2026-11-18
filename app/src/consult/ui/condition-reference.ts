/**
 * Curated, static educational reference for conditions a patient may name. It is NOT produced by the model and is NOT
 * a diagnosis or a prescription: it lists commonly used confirmatory investigations and medicine CLASSES (no named
 * doses, no regimens) for a clinician to review. Opening it never changes the observation: the patient-stated
 * condition stays unconfirmed. Content is unreviewed until a clinician signs it off.
 */
export interface ConditionReference {
  readonly tests: readonly string[];
  readonly medicines: readonly string[];
}

export const REFERENCE_NOTICE = 'Educational reference only. Not a diagnosis or prescription. Doses are deliberately not listed. Clinician to decide.';

const ENTRIES: Record<string, ConditionReference> = {
  pneumonia: {
    tests: ['Chest X-ray', 'Full blood count and CRP', 'Sputum culture', 'Pulse oximetry', 'Blood cultures if severe'],
    medicines: ['Antibiotics (class chosen by severity and local guidance)', 'Antipyretic / analgesic', 'Oxygen if hypoxic'],
  },
  asthma: {
    tests: ['Spirometry with reversibility', 'Peak expiratory flow', 'FeNO', 'Allergy testing'],
    medicines: ['Short-acting bronchodilator (reliever)', 'Inhaled corticosteroid (controller)', 'Leukotriene antagonist'],
  },
  copd: {
    tests: ['Post-bronchodilator spirometry', 'Chest X-ray', 'Pulse oximetry', 'Full blood count'],
    medicines: ['Long-acting bronchodilators', 'Inhaled corticosteroid in selected patients', 'Short-acting reliever'],
  },
  tuberculosis: {
    tests: ['Sputum smear and culture', 'Nucleic acid amplification test', 'Chest X-ray', 'Tuberculin skin or IGRA test', 'HIV test'],
    medicines: ['Multi-drug anti-tubercular regimen per national programme'],
  },
  bronchitis: {
    tests: ['Clinical review', 'Chest X-ray to exclude pneumonia', 'Pulse oximetry'],
    medicines: ['Mostly supportive care', 'Antipyretic / analgesic', 'Antibiotics only if bacterial infection suspected'],
  },
  diabetes: {
    tests: ['Fasting plasma glucose', 'HbA1c', 'Oral glucose tolerance test', 'Urine albumin'],
    medicines: ['Biguanide', 'Other oral glucose-lowering classes', 'Insulin where indicated'],
  },
  hypertension: {
    tests: ['Repeat blood pressure / ambulatory monitoring', 'Renal function and electrolytes', 'Lipid profile', 'ECG', 'Urinalysis'],
    medicines: ['ACE inhibitor or ARB', 'Calcium-channel blocker', 'Thiazide-like diuretic'],
  },
  'heart failure': {
    tests: ['NT-proBNP', 'Echocardiogram', 'ECG', 'Chest X-ray', 'Renal function and electrolytes'],
    medicines: ['ACE inhibitor or ARNI', 'Beta-blocker', 'Mineralocorticoid antagonist', 'Loop diuretic for congestion'],
  },
};

const ALIASES: Record<string, string> = {
  tb: 'tuberculosis', 'pulmonary tuberculosis': 'tuberculosis', 'chronic obstructive pulmonary disease': 'copd',
  'high blood pressure': 'hypertension', 'high bp': 'hypertension', sugar: 'diabetes', 'type 2 diabetes': 'diabetes', 'type 1 diabetes': 'diabetes',
};

export function conditionReference(label: string | null | undefined): ConditionReference | null {
  const key = (label ?? '').trim().toLowerCase();
  return ENTRIES[ALIASES[key] ?? key] ?? null;
}
