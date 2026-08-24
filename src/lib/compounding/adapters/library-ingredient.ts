/**
 * N of 1 — Rev15 library ingredient type
 * ----------------------------------------
 * Full TypeScript interface for a row in data/library-built/ingredients-library.json.
 *
 * Relationship to the existing LibraryIngredientForGranules in lib/granule-calc.ts:
 * LibraryIngredientForGranules is a 4-field projection used only for granule
 * arithmetic. This interface is the complete record used by the adapter layer.
 *
 * Field notes:
 *   - plant_part, preparation_type, extract_ratio, standardisation are present on
 *     every entry including non-herbals, where they are set to the literal string "-".
 *   - price_per_granule_aud is stored as a string (e.g. "0.0042") to preserve
 *     exact decimal representation from the source data.
 *   - equiv_line_2 / equiv_line_3 are absent (undefined) on 26 entries. Absent
 *     means the active IS the moiety; there is no conversion step.
 *   - clinical_details is present on all 107 Rev15 entries.
 */

export type LibraryIngredientCategory =
  | 'Herb'
  | 'Vitamin'
  | 'Synthetic'
  | 'Amino acid'
  | 'Natural'
  | 'Mineral'
  | 'Enzyme';

export type LibraryDoseUnit = 'mg' | 'mcg';

export type LibraryEquiv2Unit = 'mg' | 'mcg' | 'IU' | 'mcg RE' | 'PU';

export type LibraryEquiv3Unit = 'mg' | 'mcg' | 'IU';

export interface ClinicalDetails {
  introduction?: string;
  side_effects_and_risks?: string;
  references?: string;
}

export interface LibraryIngredient {
  /** TSI (W) code. Format: one uppercase letter + 9 digits, e.g. "W040002000". */
  tsi_code: string;
  /** Whether this ingredient is currently orderable. */
  available: boolean;
  /** Retail price per granule in AUD, stored as string to preserve decimal precision. */
  price_per_granule_aud: string;
  /** Human-readable active ingredient name, e.g. "Magnesium (as magnesium glycinate)". */
  active_ingredient: string;
  /** Short common name used in the formulation schedule, e.g. "Magnesium glycinate". */
  common_name: string;
  /** TGA/TSI active code, e.g. "A228". */
  tsic_active_code: string;
  /** Binomial species name for herbals; "-" for non-herbals. */
  scientific_name: string;
  /** TGA-approved ingredient name as it appears on labels. */
  tga_approved_name: string;
  /** Plant part used, e.g. "root", "leaf"; "-" for non-herbals. */
  plant_part: string;
  /** Preparation type, e.g. "extract dry concentrate standardised"; "-" for non-herbals. */
  preparation_type: string;
  /**
   * Extract concentration ratio, e.g. "4:1" meaning 1g of extract came from 4g of herb.
   * "-" for non-herbal or non-standardised entries.
   */
  extract_ratio: string;
  /**
   * Standardisation specification, e.g. "9% ginsenosides".
   * "-" for non-standardised entries.
   */
  standardisation: string;
  /**
   * Multi-line TGA label expression. Lines are separated by "\n".
   *
   * Line 1: primary ingredient (the physical substance in the granule).
   * Line 2: TGA-required "equivalent" declaration — semantics vary by category:
   *   - Mineral: elemental equivalent (e.g. "equivalent magnesium (Mg)")
   *   - Herb:    dry herb equivalent (e.g. "equivalent Withania somnifera dry root")
   *   - Other:   free base, active form, or IU/PU equivalence
   * Line 3 (standardised herbs only): standardised marker constituent
   *   (e.g. "equivalent ginsenosides")
   */
  label_expression: string;
  /** Physical mass of one granule in milligrams. */
  granule_weight_mg: number;
  /** Dose of the line-1 substance (salt / extract) per granule. */
  dose_per_granule: number;
  /** Unit for dose_per_granule. All Rev15 entries use 'mg' or 'mcg'. */
  dose_per_granule_unit: LibraryDoseUnit;
  /**
   * Quantity for the line-2 equivalent per granule. Absent on 26 entries
   * where the active IS the moiety (no conversion step required).
   */
  equivalent_line_2_quantity?: number;
  /**
   * Unit for equivalent_line_2_quantity. May be a non-mass unit (IU, mcg RE, PU)
   * for vitamins and enzymes.
   */
  equivalent_line_2_unit?: LibraryEquiv2Unit;
  /**
   * Quantity for the line-3 standardised marker per granule.
   * Present only on standardised herbal extracts.
   */
  equivalent_line_3_quantity?: number;
  /** Unit for equivalent_line_3_quantity. */
  equivalent_line_3_unit?: LibraryEquiv3Unit;
  /** Maximum daily dose as a string (unit = unit_of_measure). */
  max_dose: string;
  /** Recommended daily dose as a string (unit = unit_of_measure). */
  recommended_dose: string;
  /** Unit for max_dose and recommended_dose (e.g. "mg", "mcg"). */
  unit_of_measure: string;
  /** Ingredient category. */
  category: LibraryIngredientCategory;
  /** Comma-separated TGA regulatory status values, e.g. "Listed, OTC". */
  regulatory_status: string;
  /** TGA-mandated label restriction text; "No restrictions." if none. */
  tga_restrictions: string;
  /** TGA-mandated warning text; "No warnings." if none. */
  tga_warnings: string;
  /** Internal justification for the max_dose limit. */
  max_dose_justification: string;
  /** Narrative clinical data: introduction, side effects, references. */
  clinical_details: ClinicalDetails;
}
