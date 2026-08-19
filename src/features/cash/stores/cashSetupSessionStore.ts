import { createBaseStore } from '@storesjs/stores';

export type CashSetupDateOfBirth = {
  year: number;
  month: number;
  day: number;
};

export type CashSetupIdentity = {
  firstName: string;
  lastName: string;
  dateOfBirth: CashSetupDateOfBirth;
};

export type PhoneVerificationChallenge = Readonly<{ kind: 'signup'; userId: string }> | Readonly<{ kind: 'resume'; resumeId: string }>;

export type RecoveryPhoneChallenge = Readonly<{ kind: 'recovery'; recoveryId: string }>;

/**
 * Identifies an accepted phone submission by reference so async
 * results can be checked against the submission that started them.
 */
export type PhoneChallenge = PhoneVerificationChallenge | RecoveryPhoneChallenge;

export type CashSetupGovernmentIdKind = 'GOVERNMENT_ID_KIND_SSN_LAST4';

declare const cashSetupUsSsnLast4Brand: unique symbol;

export type CashSetupUsSsnLast4 = string & { readonly [cashSetupUsSsnLast4Brand]: true };

export type CashSetupGovernmentId = {
  countryCode: 'US';
  kind: CashSetupGovernmentIdKind;
  value: CashSetupUsSsnLast4;
};

type EmptyCashSetupSession = {
  status: 'empty';
};

type PhoneSubmittedCashSetupSession = {
  status: 'phoneSubmitted';
  phoneNationalNumber: string;
  challenge: PhoneVerificationChallenge;
  resendAfter: number;
};

type RecoveryCashSetupSession = {
  status: 'recovery';
  phoneNationalNumber: string;
  challenge: RecoveryPhoneChallenge;
  resendAfter: number;
  identity: CashSetupIdentity | null;
  governmentId: CashSetupGovernmentId | null;
};

type PhoneAlreadyRegisteredCashSetupSession = {
  status: 'phoneAlreadyRegistered';
  phoneNationalNumber: string;
};

type VerifiedCashSetupSession = {
  status: 'phoneVerified';
  source: PhoneChallenge['kind'];
  phoneNationalNumber: string;
  bootstrapToken: string;
  bootstrapTokenExpiresAt: number;
  identity: CashSetupIdentity | null;
  governmentId: CashSetupGovernmentId | null;
};

type CashSetupSession =
  | EmptyCashSetupSession
  | PhoneSubmittedCashSetupSession
  | RecoveryCashSetupSession
  | PhoneAlreadyRegisteredCashSetupSession
  | VerifiedCashSetupSession;

type CashSetupSessionStore = {
  session: CashSetupSession;
  getIsCurrentChallenge: (challenge: PhoneChallenge) => boolean;
  hasRecoverableSession: () => boolean;
  setPhoneSubmitted: (params: { challenge: PhoneChallenge; phoneNationalNumber: string; resendAfter: number }) => void;
  setPhoneAlreadyRegistered: (phoneNationalNumber: string) => void;
  setResendAfter: (challenge: PhoneChallenge, resendAfter: number) => void;
  replaceRecoveryChallenge: (challenge: RecoveryPhoneChallenge, next: RecoveryPhoneChallenge, resendAfter: number) => void;
  setPhoneVerified: (challenge: PhoneChallenge, credential: { bootstrapToken: string; expiresAt: number }) => void;
  setIdentity: (identity: CashSetupIdentity) => void;
  setGovernmentId: (governmentId: CashSetupGovernmentId) => void;
  reset: () => void;
};

const EMPTY_SESSION: EmptyCashSetupSession = { status: 'empty' };

/**
 * Memory-only store that manages registration state and PII for the Cash setup flow.
 */
export const useCashSetupSessionStore = createBaseStore<CashSetupSessionStore>((set, get) => ({
  session: EMPTY_SESSION,

  getIsCurrentChallenge: challenge => {
    const { session } = get();
    return (session.status === 'phoneSubmitted' || session.status === 'recovery') && session.challenge === challenge;
  },

  hasRecoverableSession: () => isSessionRecoverable(get().session),

  setPhoneSubmitted: ({ challenge, phoneNationalNumber, resendAfter }) =>
    set({
      session:
        challenge.kind === 'recovery'
          ? { status: 'recovery', challenge, phoneNationalNumber, resendAfter, identity: null, governmentId: null }
          : { status: 'phoneSubmitted', challenge, phoneNationalNumber, resendAfter },
    }),

  setPhoneAlreadyRegistered: phoneNationalNumber => set({ session: { status: 'phoneAlreadyRegistered', phoneNationalNumber } }),

  setResendAfter: (challenge, resendAfter) =>
    set(state => {
      const { session } = state;
      if (
        (session.status !== 'phoneSubmitted' && session.status !== 'recovery') ||
        session.challenge !== challenge ||
        session.resendAfter === resendAfter
      )
        return state;
      return { session: { ...session, resendAfter } };
    }),

  replaceRecoveryChallenge: (challenge, next, resendAfter) =>
    set(state => {
      const { session } = state;
      if (session.status !== 'recovery' || session.challenge !== challenge) return state;
      return { session: { ...session, challenge: next, resendAfter } };
    }),

  setPhoneVerified: (challenge, { bootstrapToken, expiresAt }) =>
    set(state => {
      const { session } = state;
      if ((session.status !== 'phoneSubmitted' && session.status !== 'recovery') || session.challenge !== challenge) return state;
      return {
        session: {
          status: 'phoneVerified',
          source: challenge.kind,
          phoneNationalNumber: session.phoneNationalNumber,
          bootstrapToken,
          bootstrapTokenExpiresAt: expiresAt,
          identity: session.status === 'recovery' ? session.identity : null,
          governmentId: session.status === 'recovery' ? session.governmentId : null,
        },
      };
    }),

  setIdentity: identity =>
    set(state => {
      if (!hasIdentityDraft(state.session)) return state;
      return { session: { ...state.session, identity } };
    }),

  setGovernmentId: governmentId =>
    set(state => {
      if (!hasIdentityDraft(state.session)) return state;
      return { session: { ...state.session, governmentId } };
    }),

  reset: () => set(state => (state.session === EMPTY_SESSION ? state : { session: EMPTY_SESSION })),
}));

export function selectIsPhoneVerified(state: CashSetupSessionStore): boolean {
  return state.session.status === 'phoneVerified' && state.session.bootstrapTokenExpiresAt > Date.now();
}

export function selectResendAfter(state: CashSetupSessionStore): number | null {
  return state.session.status === 'phoneSubmitted' || state.session.status === 'recovery' ? state.session.resendAfter : null;
}

export function selectCashSetupIdentity(state: CashSetupSessionStore): CashSetupIdentity | null {
  return hasIdentityDraft(state.session) ? state.session.identity : null;
}

export function selectCashSetupGovernmentId(state: CashSetupSessionStore): CashSetupGovernmentId | null {
  return hasIdentityDraft(state.session) ? state.session.governmentId : null;
}

function isSessionRecoverable(session: CashSetupSession): boolean {
  if (session.status !== 'recovery') return false;
  return session.identity !== null && session.governmentId !== null;
}

function hasIdentityDraft(session: CashSetupSession): session is RecoveryCashSetupSession | VerifiedCashSetupSession {
  return session.status === 'recovery' || session.status === 'phoneVerified';
}
