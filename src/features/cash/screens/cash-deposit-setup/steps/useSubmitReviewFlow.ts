import { createBaseStore, createStoreActions } from '@storesjs/stores';

import { analytics } from '@/analytics';
import { getRemoteConfig } from '@/features/config/stores/remoteConfig';
import { time } from '@/framework/core/utils/time';
import { logger, RainbowError } from '@/logger';
import { delay } from '@/utils/delay';

import { US_COUNTRY_CODE } from '../../../services/cashSetupIdentityService';
import {
  finishRecovery,
  getUserStatus,
  KycStatus,
  startRecovery,
  startSignupResume,
  submitOnboarding,
  type KycOutcome,
} from '../../../services/userClient';
import { useCashSetupSessionStore } from '../../../stores/cashSetupSessionStore';
import { OTP_LENGTH, useVerifyPhoneFlowStore } from '../../../stores/verifyPhoneFlowStore';

export const KYC_POLL_INTERVAL_MS = time.seconds(3);

export type SubmitReviewState = 'entry' | 'submitting' | 'error' | 'locked' | KycOutcome;

type SubmitReviewResult =
  | 'approved'
  | 'rejected'
  | 'awaitingDecision'
  | 'recovered'
  | 'phoneCodeRequired'
  | 'failed'
  | 'cancelled'
  | 'skipped';

// After submission, every non-verdict status means the provider is still deciding.
function isAwaitingDecision(status: KycStatus): boolean {
  return status !== KycStatus.Approved && status !== KycStatus.Rejected;
}

type SubmitReviewFlowStore = {
  state: SubmitReviewState;
  // Invalidates an onboarding poll when the screen resets this module-level store.
  kycRun: object | null;
  reset: () => void;
  submit: () => Promise<SubmitReviewResult>;
};

export const useSubmitReviewFlowStore = createBaseStore<SubmitReviewFlowStore>((set, get) => ({
  state: 'entry',
  kycRun: null,

  reset: () => set({ kycRun: null, state: 'entry' }),

  submit: async () => {
    const { state } = get();
    if (state === 'submitting' || state === 'reviewing' || state === 'locked') return 'skipped';

    const sessionStore = useCashSetupSessionStore.getState();
    const { session } = sessionStore;

    if (session.status === 'recovery') {
      const code = useVerifyPhoneFlowStore.getState().code;
      if (!session.identity || !session.governmentId || code.length !== OTP_LENGTH) return 'skipped';

      const { challenge, phoneNationalNumber, identity, governmentId } = session;
      set({ kycRun: null, state: 'submitting' });
      const isStale = () => !sessionStore.getIsCurrentChallenge(challenge);

      try {
        const result = await finishRecovery({ recoveryId: challenge.recoveryId, code, identity, governmentId });
        if (isStale()) return 'cancelled';

        if (result.outcome === 'recovered') {
          sessionStore.setPhoneVerified(challenge, result);
          analytics.track(analytics.event.cashPhoneVerified, { mode: 'recovery' });
          set({ state: 'entry' });
          return 'recovered';
        }

        if (result.outcome === 'identityMismatch') {
          set({ state: 'error' });
          return 'failed';
        }

        if (result.outcome === 'codeInvalid') {
          useVerifyPhoneFlowStore.getState().rejectCode();
          analytics.track(analytics.event.cashPhoneVerifyFailed, { mode: 'recovery', reason: 'invalidCode' });
          set({ state: 'entry' });
          return 'phoneCodeRequired';
        }

        if (result.outcome === 'accessBlocked') {
          set({ state: 'locked' });
          return 'failed';
        }

        if (result.outcome === 'sessionInvalid') {
          const { recoveryId, resendAfter } = await startRecovery({ nationalNumber: phoneNationalNumber });
          if (isStale()) return 'cancelled';
          sessionStore.replaceRecoveryChallenge(challenge, { kind: 'recovery', recoveryId }, resendAfter);
        } else {
          const { resumeId, resendAfter } = await startSignupResume({ nationalNumber: phoneNationalNumber });
          if (isStale()) return 'cancelled';
          sessionStore.setPhoneSubmitted({
            challenge: { kind: 'resume', resumeId },
            phoneNationalNumber,
            resendAfter,
          });
          analytics.track(analytics.event.cashPhoneSubmitted, { mode: 'resume' });
        }

        useVerifyPhoneFlowStore.getState().reset();
        set({ state: 'entry' });
        return 'phoneCodeRequired';
      } catch (error) {
        if (isStale()) return 'cancelled';
        logger.error(new RainbowError('[useSubmitReviewFlow]: Failed to recover account', error));
        set({ state: 'error' });
        return 'failed';
      }
    }

    if (session.status !== 'phoneVerified' || !session.identity || !session.governmentId) return 'skipped';
    const { bootstrapToken, identity, governmentId } = session;

    const kycRun = {};
    set({ kycRun, state: 'submitting' });
    analytics.track(analytics.event.cashKycSubmitted);

    const isStale = () => get().kycRun !== kycRun;
    let trackedAwaitingDecision = false;
    const enterReviewing = () => {
      if (!trackedAwaitingDecision) {
        trackedAwaitingDecision = true;
        analytics.track(analytics.event.cashKycAwaitingDecision, { source: 'submit' });
      }
      set({ state: 'reviewing' });
    };

    let kycStatus: KycStatus;
    try {
      ({ kycStatus } = await submitOnboarding({ bootstrapToken, countryCode: US_COUNTRY_CODE, identity, governmentId }));
    } catch (error) {
      if (isStale()) return 'cancelled';
      logger.error(new RainbowError('[useSubmitReviewFlow]: Failed to submit KYC', error));
      analytics.track(analytics.event.cashKycFailed, { reason: error instanceof Error ? error.message : String(error) });
      set({ state: 'error' });
      return 'failed';
    }
    if (isStale()) return 'cancelled';

    const reviewingAt = Date.now() + getRemoteConfig().cash_kyc_review_delay_ms;

    while (isAwaitingDecision(kycStatus)) {
      if (Date.now() >= reviewingAt) enterReviewing();
      await delay(KYC_POLL_INTERVAL_MS);
      if (isStale()) return 'cancelled';
      try {
        ({ kycStatus } = await getUserStatus({ bootstrapToken }));
      } catch (error) {
        if (isStale()) return 'cancelled';
        logger.warn('[useSubmitReviewFlow]: KYC status poll failed', { error });
        enterReviewing();
        return 'awaitingDecision';
      }
      if (isStale()) return 'cancelled';
    }

    if (kycStatus === KycStatus.Approved) {
      analytics.track(analytics.event.cashKycApproved);
      set({ state: 'approved' });
      return 'approved';
    }

    analytics.track(analytics.event.cashKycFailed, { reason: 'rejected' });
    set({ state: 'rejected' });
    return 'rejected';
  },
}));

const submitReviewFlowActions = createStoreActions(useSubmitReviewFlowStore);

export function useSubmitReviewFlow(): {
  reset: () => void;
  state: SubmitReviewState;
  submit: () => Promise<SubmitReviewResult>;
} {
  const state = useSubmitReviewFlowStore(state => state.state);

  return { reset: submitReviewFlowActions.reset, state, submit: submitReviewFlowActions.submit };
}
