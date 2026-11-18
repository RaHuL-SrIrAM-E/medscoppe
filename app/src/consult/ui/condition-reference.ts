/**
 * Curated, static educational reference for conditions a patient may name. It is NOT produced by the model and is NOT
 * a diagnosis or a prescription: it lists commonly used confirmatory investigations and medicine CLASSES (no named
 * doses, no regimens) for a clinician to review. Opening it never changes the observation: the patient-stated
 * condition stays unconfirmed. Content is unreviewed until a clinician signs it off.
 */
export interface ConditionReference {
  readonly name: string;
  readonly tests: readonly string[];
  readonly medicines: readonly string[];
}

export const REFERENCE_NOTICE = 'Educational reference only. Not a diagnosis or prescription. Doses are deliberately not listed. Clinician to decide.';

const ENTRIES: Record<string, ConditionReference> = {
  pneumonia: {
    name: 'Pneumonia',
    tests: ['Chest X-ray', 'Full blood count and CRP', 'Sputum culture', 'Pulse oximetry', 'Blood cultures if severe'],
    medicines: ['Antibiotics (class chosen by severity and local guidance)', 'Antipyretic / analgesic', 'Oxygen if hypoxic'],
  },
  asthma: {
    name: 'Asthma',
    tests: ['Spirometry with reversibility', 'Peak expiratory flow', 'FeNO', 'Allergy testing'],
    medicines: ['Short-acting bronchodilator (reliever)', 'Inhaled corticosteroid (controller)', 'Leukotriene antagonist'],
  },
  copd: {
    name: 'COPD',
    tests: ['Post-bronchodilator spirometry', 'Chest X-ray', 'Pulse oximetry', 'Full blood count'],
    medicines: ['Long-acting bronchodilators', 'Inhaled corticosteroid in selected patients', 'Short-acting reliever'],
  },
  tuberculosis: {
    name: 'Tuberculosis',
    tests: ['Sputum smear and culture', 'Nucleic acid amplification test', 'Chest X-ray', 'Tuberculin skin or IGRA test', 'HIV test'],
    medicines: ['Multi-drug anti-tubercular regimen per national programme'],
  },
  bronchitis: {
    name: 'Bronchitis',
    tests: ['Clinical review', 'Chest X-ray to exclude pneumonia', 'Pulse oximetry'],
    medicines: ['Mostly supportive care', 'Antipyretic / analgesic', 'Antibiotics only if bacterial infection suspected'],
  },
  diabetes: {
    name: 'Diabetes',
    tests: ['Fasting plasma glucose', 'HbA1c', 'Oral glucose tolerance test', 'Urine albumin'],
    medicines: ['Biguanide', 'Other oral glucose-lowering classes', 'Insulin where indicated'],
  },
  hypertension: {
    name: 'Hypertension',
    tests: ['Repeat blood pressure / ambulatory monitoring', 'Renal function and electrolytes', 'Lipid profile', 'ECG', 'Urinalysis'],
    medicines: ['ACE inhibitor or ARB', 'Calcium-channel blocker', 'Thiazide-like diuretic'],
  },
  'heart failure': {
    name: 'Heart failure',
    tests: ['NT-proBNP', 'Echocardiogram', 'ECG', 'Chest X-ray', 'Renal function and electrolytes'],
    medicines: ['ACE inhibitor or ARNI', 'Beta-blocker', 'Mineralocorticoid antagonist', 'Loop diuretic for congestion'],
  },
  influenza: {
    name: 'Influenza',
    tests: ['Rapid influenza test or PCR', 'Pulse oximetry', 'Chest X-ray if breathless'],
    medicines: ['Antiviral (if early or high risk)', 'Antipyretic / analgesic', 'Fluids and rest'],
  },
  'common cold': {
    name: 'Common cold',
    tests: ['Clinical review (usually no tests)'],
    medicines: ['Supportive care', 'Antipyretic / analgesic', 'Decongestant (short course)'],
  },
  'pulmonary embolism': {
    name: 'Pulmonary embolism',
    tests: ['Clinical probability score', 'D-dimer', 'CT pulmonary angiogram', 'ECG', 'Pulse oximetry'],
    medicines: ['Anticoagulant', 'Oxygen if hypoxic'],
  },
  'lung cancer': {
    name: 'Lung cancer',
    tests: ['Chest X-ray', 'CT chest', 'Bronchoscopy with biopsy', 'Sputum cytology'],
    medicines: ['Specialist oncology-directed therapy', 'Symptom control'],
  },
  angina: {
    name: 'Angina / coronary artery disease',
    tests: ['ECG', 'Troponin', 'Exercise stress test', 'Coronary CT or angiography'],
    medicines: ['Antiplatelet', 'Beta-blocker', 'Nitrate', 'Statin'],
  },
  gerd: {
    name: 'GERD (acid reflux)',
    tests: ['Clinical review', 'Upper GI endoscopy if alarm features', 'Trial of acid suppression'],
    medicines: ['Proton-pump inhibitor', 'Antacid / alginate'],
  },
  pharyngitis: {
    name: 'Pharyngitis / tonsillitis',
    tests: ['Throat examination', 'Rapid antigen test or throat swab'],
    medicines: ['Analgesic / antipyretic', 'Antibiotic only if bacterial'],
  },
  anaemia: {
    name: 'Anaemia',
    tests: ['Full blood count', 'Ferritin and iron studies', 'Vitamin B12 and folate', 'Reticulocyte count'],
    medicines: ['Treat the cause', 'Iron or vitamin replacement where deficient'],
  },
  hypothyroidism: {
    name: 'Hypothyroidism',
    tests: ['TSH', 'Free T4', 'Thyroid antibodies'],
    medicines: ['Thyroid hormone replacement'],
  },
  'allergic rhinitis': {
    name: 'Allergic rhinitis',
    tests: ['Clinical review', 'Allergy skin-prick or specific IgE test'],
    medicines: ['Antihistamine', 'Intranasal corticosteroid', 'Allergen avoidance'],
  },
  sinusitis: {
    name: 'Sinusitis',
    tests: ['Clinical review', 'Nasal endoscopy or CT sinuses if persistent'],
    medicines: ['Saline irrigation', 'Intranasal corticosteroid', 'Antibiotic only if bacterial'],
  },
  migraine: {
    name: 'Migraine',
    tests: ['Clinical review', 'Neuro-imaging only if red-flag features'],
    medicines: ['Analgesic / NSAID', 'Triptan', 'Preventive therapy if frequent'],
  },
  'tension headache': {
    name: 'Tension-type headache',
    tests: ['Clinical review', 'Blood pressure and eye check'],
    medicines: ['Simple analgesic', 'Stress and sleep measures'],
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

/** Conditions commonly considered for a symptom: an educational prompt for the doctor, NOT a differential or a diagnosis. */
const SYMPTOM_CAUSES: Record<string, readonly string[]> = {
  COUGH: ['pneumonia', 'bronchitis', 'asthma', 'copd', 'tuberculosis'],
  FEVER: ['influenza', 'pneumonia', 'tuberculosis', 'common cold', 'bronchitis'],
  DYSPNOEA: ['asthma', 'copd', 'pneumonia', 'heart failure', 'pulmonary embolism'],
  CHEST_PAIN: ['angina', 'pneumonia', 'pulmonary embolism', 'gerd'],
  WHEEZE: ['asthma', 'copd', 'bronchitis', 'heart failure'],
  HAEMOPTYSIS: ['tuberculosis', 'lung cancer', 'pneumonia', 'bronchitis', 'pulmonary embolism'],
  SORE_THROAT: ['pharyngitis', 'common cold', 'influenza'],
  FATIGUE: ['anaemia', 'diabetes', 'hypothyroidism', 'heart failure'],
  NASAL_CONGESTION: ['common cold', 'allergic rhinitis', 'sinusitis'],
  HEADACHE: ['migraine', 'tension headache', 'hypertension', 'sinusitis'],
};

export interface CauseChoice {
  readonly key: string;
  readonly name: string;
}

export function commonCauses(symptom: string | null | undefined): readonly CauseChoice[] {
  return (SYMPTOM_CAUSES[symptom ?? ''] ?? []).map((key) => ({ key, name: ENTRIES[key]!.name }));
}

export function referenceByKey(key: string | null | undefined): ConditionReference | null {
  return key ? ENTRIES[key] ?? null : null;
}
