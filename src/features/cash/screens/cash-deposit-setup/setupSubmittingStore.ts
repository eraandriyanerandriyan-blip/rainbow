import { createDerivedStore } from '@storesjs/stores';

import { useCardLinkFlowStore } from '../../stores/cardLinkFlowStore';
import { useVerifyPhoneFlowStore } from '../../stores/verifyPhoneFlowStore';
import { useAddPasskeyFlowStore } from './steps/useAddPasskeyFlow';
import { useSubmitPhoneFlowStore } from './steps/useSubmitPhoneFlow';
import { useSubmitReviewFlowStore } from './steps/useSubmitReviewFlow';

/** True while any Setup submission is in flight; disables every back/cancel affordance. */
export const useIsSetupSubmittingStore = createDerivedStore<boolean>(
  $ => {
    const submittingPhone = $(useSubmitPhoneFlowStore, state => state.state === 'submitting');
    const verifyingPhone = $(useVerifyPhoneFlowStore, state => state.state === 'verifying');
    const submittingReview = $(useSubmitReviewFlowStore, state => state.state === 'submitting');
    const addingPasskey = $(useAddPasskeyFlowStore, state => state.state === 'submitting');
    const linkingCard = $(useCardLinkFlowStore, state => state.state === 'submitting');
    return submittingPhone || verifyingPhone || submittingReview || addingPasskey || linkingCard;
  },
  { lockDependencies: true }
);
