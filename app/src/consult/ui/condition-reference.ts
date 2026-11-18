/**
 * Curated, static educational reference for conditions a patient may name. It is NOT produced by the model and is NOT
 * a diagnosis or a prescription: it lists commonly used confirmatory investigations and medicine CLASSES (no named
 * doses, no regimens) for a clinician to review. Opening it never changes the observation: the patient-stated
 * condition stays unconfirmed. Content is unreviewed until a clinician signs it off.
 */
/**
 * How a condition can look on a chest film, as a SCHEMATIC. Everything is drawn from `pattern`; there is no patient image.
 * `marker` is the finding's centre on the film (0..1, film left = patient's right) and `structureIds` are the anatomy
 * structures that glow when the doctor asks where it sits in the body.
 */
export type XrayPattern = 'CONSOLIDATION' | 'UPPER_CAVITY' | 'HYPERINFLATION' | 'CARDIAC_CONGESTION' | 'MASS';

export interface XrayFinding {
  readonly pattern: XrayPattern;
  readonly title: string;
  readonly look: string;
  readonly marker: { readonly x: number; readonly y: number };
  readonly structureIds: readonly string[];
}

export interface ConditionReference {
  readonly name: string;
  readonly xray?: XrayFinding;
  readonly tests: readonly string[];
  readonly medicines: readonly string[];
}

export const REFERENCE_NOTICE = 'Educational reference only. Not a diagnosis or prescription. Doses are deliberately not listed. Clinician to decide.';

const ENTRIES: Record<string, ConditionReference> = {
  pneumonia: {
    name: 'Pneumonia',
    xray: {
      pattern: 'CONSOLIDATION',
      title: 'Right lower zone opacity',
      look: 'A patchy white area in the right lower lung where air is replaced by fluid and cells. The edge is hazy and the airways inside can show as dark lines (air bronchograms).',
      marker: { x: 0.33, y: 0.68 },
      structureIds: ['respiratory.lung.right.lower-lobe'],
    },
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
    xray: {
      pattern: 'HYPERINFLATION',
      title: 'Hyperinflated lungs',
      look: 'Both lungs look large and unusually dark. The diaphragm sits low and flat, the ribs run more horizontally, and the heart looks long and narrow.',
      marker: { x: 0.5, y: 0.5 },
      structureIds: ['respiratory.lung.right', 'respiratory.lung.left', 'respiratory.diaphragm'],
    },
    tests: ['Post-bronchodilator spirometry', 'Chest X-ray', 'Pulse oximetry', 'Full blood count'],
    medicines: ['Long-acting bronchodilators', 'Inhaled corticosteroid in selected patients', 'Short-acting reliever'],
  },
  tuberculosis: {
    name: 'Tuberculosis',
    xray: {
      pattern: 'UPPER_CAVITY',
      title: 'Upper zone infiltrate with a cavity',
      look: 'Patchy shadowing high in the right lung, often with a thin-walled dark hole (cavity) inside it. Upper zones are the typical place.',
      marker: { x: 0.35, y: 0.3 },
      structureIds: ['respiratory.lung.right.upper-lobe'],
    },
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
    xray: {
      pattern: 'CARDIAC_CONGESTION',
      title: 'Enlarged heart with lung congestion',
      look: 'The heart shadow is wider than half the chest. Hazy white fluid fans out from the centre of both lungs, and the angles at the bottom corners are blunted by fluid.',
      marker: { x: 0.5, y: 0.6 },
      structureIds: ['respiratory.lung.right', 'respiratory.lung.left'],
    },
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
    xray: {
      pattern: 'MASS',
      title: 'Left upper zone mass',
      look: 'A rounded white lump in the upper left lung with an uneven, spiky edge. It may be mistaken for an infection, so follow-up imaging is needed.',
      marker: { x: 0.66, y: 0.3 },
      structureIds: ['respiratory.lung.left.upper-lobe'],
    },
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

export const XRAY_NOTICE = 'ILLUSTRATIVE SCHEMATIC - NOT A REAL PATIENT IMAGE';
