/**
 * Hardcoded RCS sender template for the Gemini Enterprise integration.
 *
 * The connector user only supplies `name` and `description`; everything else (brand assets,
 * legal URLs, contact, and the onboarding questionnaire) is fixed company data and filled in
 * here so the agent doesn't have to ask for it. The questionnaire below is for FRANCE (`fr`),
 * which is why FR is the recommended launch country (see RECOMMENDED_COUNTRIES).
 */

// ISO 3166-1 alpha-2 countries supported by the Sinch RCS Provisioning API.
export const SUPPORTED_COUNTRIES = [
  'AT', 'BE', 'BR', 'CA', 'CZ', 'DK', 'FI', 'FR', 'DE', 'GR', 'HU', 'IT',
  'MX', 'NL', 'NO', 'PE', 'PL', 'PT', 'SG', 'SK', 'ES', 'SE', 'US', 'GB',
] as const;

// The questionnaire provided below only fills the `fr` section, so France is the country that
// can be launched as-is. Other countries (e.g. GB, US) need their own questionnaire sections.
export const RECOMMENDED_COUNTRIES = ['FR'] as const;

export function buildCreateSenderBody(name: string, description: string) {
  return {
    region: 'EU',
    billingCategory: 'CONVERSATIONAL',
    useCase: 'MULTIUSE',
    details: {
      brand: {
        name,
        description,
        bannerUrl: 'https://i.ibb.co/nqM3dtxF/sinch-banner.png',
        logoUrl: 'https://i.ibb.co/pjvqm7z7/sinch-224.png',
        privacyPolicyUrl: 'https://sinch.com/es/legal/emea-terms/privacy-policy/',
        termsOfServiceUrl:
          'https://sinch.com/legal/terms-and-conditions/other-sinch-terms-conditions/terms-of-service/',
        emails: [{ label: 'Lead dev', address: 'antoine.sein@sinch.com' }],
      },
      questionnaire: {
        general: {
          answers: {
            videoUris: ['https://www.youtube.com/watch?v=0fT_5iazkso'],
            optInDescription: 'By subscribing to our loyalty program',
            triggerDescription: 'Business-triggered (e.g. marketing and promotions)',
            interactionsDescription: 'After user makes a purchase',
            optOutDescription: 'Thank you for opting out',
          },
        },
        verification: {
          answers: {
            name: 'Antoine Sein',
            email: 'antoine.sein@sinch.com',
            title: 'Lead dev',
            website: 'https://sinch.com/',
          },
        },
        fr: {
          answers: {
            fullCompanyAddress: '43 Rue de Dunkerque, 75010 Paris, France',
            siren: '524353299',
          },
        },
      },
    },
  };
}
