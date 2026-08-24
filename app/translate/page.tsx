/**
 * app/translate/page.tsx
 * ----------------------
 * Practitioner onboarding — translate a current commercial product stack into
 * an equivalent N of 1 granule pod formulation.
 */

import { Metadata } from 'next';
import { TranslateClient } from '@/src/components/translate/TranslateClient';

export const metadata: Metadata = {
  title: 'Protocol Translator — N of 1 Precision Formulation',
  description:
    'Convert a practitioner\'s existing commercial supplement stack into a tailored N of 1 granule pod formulation.',
};

export default function TranslatePage() {
  return (
    <div className="-mx-6 -my-8">
      {/* Sub-header */}
      <div className="bg-[#535B50]/10 border-b border-[#535B50]/20 px-6 py-3">
        <h1 className="text-sm font-semibold text-[#535B50] tracking-wide">Protocol Translator</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Select commercial products a practitioner currently uses → receive an equivalent N of 1 granule pod formulation
        </p>
      </div>

      {/* Client component handles all interactivity */}
      <TranslateClient />
    </div>
  );
}
