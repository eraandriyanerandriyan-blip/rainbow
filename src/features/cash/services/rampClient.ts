import { IS_TESTING } from 'react-native-dotenv';
import { z } from 'zod';

import { parseResponse } from '@/framework/data/http/parseResponse';
import { RainbowFetchError } from '@/framework/data/http/rainbowFetch';

import { useCashAuthTokenStore } from '../stores/cashAuthTokenStore';
import type { LinkedCard } from '../stores/cashPaymentMethodStore';
import { buildAuthenticatedHeader, getCashPlatformClient } from './cashPlatformClient';
import { ensureAccessToken, type CashSignInTrigger } from './cashSignInService';

// ---- Wire enums (values mirror the platform `/v1/ramp` OpenAPI spec) --------

export enum OrderStatus {
  Unspecified = 'ORDER_STATUS_UNSPECIFIED',
  Pending = 'ORDER_STATUS_PENDING',
  Processing = 'ORDER_STATUS_PROCESSING',
  Completed = 'ORDER_STATUS_COMPLETED',
  Failed = 'ORDER_STATUS_FAILED',
}

export enum OrderFailureReason {
  Unspecified = 'ORDER_FAILURE_REASON_UNSPECIFIED',
  PaymentRejected = 'ORDER_FAILURE_REASON_PAYMENT_REJECTED',
}

export enum RampCryptoAsset {
  Unspecified = 'CRYPTO_ASSET_UNSPECIFIED',
  USDC = 'CRYPTO_ASSET_USDC',
}

export enum RampNetwork {
  Unspecified = 'NETWORK_UNSPECIFIED',
  ArbitrumTestnet = 'NETWORK_ARBITRUM_TESTNET',
  Base = 'NETWORK_BASE',
}

export enum CardBrand {
  Unspecified = 'CARD_BRAND_UNSPECIFIED',
  Visa = 'CARD_BRAND_VISA',
  Mastercard = 'CARD_BRAND_MASTERCARD',
  Amex = 'CARD_BRAND_AMEX',
  Discover = 'CARD_BRAND_DISCOVER',
}

export enum WalletSignatureMethod {
  Unspecified = 'WALLET_SIGNATURE_METHOD_UNSPECIFIED',
  EthPersonalSign = 'WALLET_SIGNATURE_METHOD_ETH_PERSONAL_SIGN',
}

// ---- Request / response shapes ---------------------------------------------

const rampAssetSchema = z.object({
  asset: z.literal(RampCryptoAsset.USDC),
  network: z.union([z.literal(RampNetwork.ArbitrumTestnet), z.literal(RampNetwork.Base)]),
});
export type RampAsset = z.infer<typeof rampAssetSchema>;

// The leading lookahead is what rejects an all-zero amount; the rest is a plain decimal.
const positiveDecimalStringSchema = z.string().regex(/^(?=.*[1-9])\d+(?:\.\d+)?$/);

const cryptoAmountSchema = z.object({ amount: positiveDecimalStringSchema, asset: rampAssetSchema });
export type CryptoAmount = z.infer<typeof cryptoAmountSchema>;

const fiatAmountSchema = z.object({ amount: z.string().min(1), currency: z.string().min(1) });
export type FiatAmount = z.infer<typeof fiatAmountSchema>;

export type BuyOrderSpec = {
  cardId: string;
  /** Fiat amount as a decimal string, e.g. "50". */
  depositAmount: string;
  /** Client-generated UUID. The backend adopts it as the order's id; a replay with the same id is idempotent (returns the existing order's status, never re-creates). */
  id: string;
  walletAddress: string;
};

export type CreateBuyOrderParams = BuyOrderSpec & {
  cryptoAsset: RampAsset;
};

const createdBuyOrderSchema = z.object({
  id: z.string().min(1),
});
export type CreatedBuyOrder = z.infer<typeof createdBuyOrderSchema>;

const buyOrderIdentitySchema = z.object({ id: z.string().min(1) });

// Each status requires exactly the fields the app reads at that status, and no more. The backend speaks
// protojson without EmitUnpopulated, so any field it has not filled in yet is absent rather than empty —
// demanding one before its status is reached would reject a response the client had no need to read.
const buyOrderSchema = z.discriminatedUnion('status', [
  buyOrderIdentitySchema.extend({ status: z.literal(OrderStatus.Pending) }),
  buyOrderIdentitySchema.extend({ status: z.literal(OrderStatus.Processing) }),
  // A completed order is filed in Activity, so everything that entry needs is required here. Without the
  // hash it is not yet actionable, and the caller keeps polling until it arrives.
  buyOrderIdentitySchema.extend({
    status: z.literal(OrderStatus.Completed),
    cryptoAmount: cryptoAmountSchema,
    fiatAmount: fiatAmountSchema,
    /** ISO 8601 timestamp of when the order was created. */
    createdTime: z.string().min(1),
    walletAddress: z.string().min(1),
    transactionHash: z.string().min(1),
    completedTime: z.string().min(1),
  }),
  buyOrderIdentitySchema.extend({
    status: z.literal(OrderStatus.Failed),
    // Kept as the raw wire string: the app only distinguishes PAYMENT_REJECTED, but analytics needs to see
    // a reason the backend added ahead of the client rather than a flattened `UNSPECIFIED`.
    failureReason: z.string().catch(OrderFailureReason.Unspecified),
  }),
]);
export type BuyOrder = z.infer<typeof buyOrderSchema>;

export type TerminalBuyOrder = Extract<BuyOrder, { status: OrderStatus.Completed | OrderStatus.Failed }>;

export function isTerminalBuyOrder(order: BuyOrder): order is TerminalBuyOrder {
  return order.status === OrderStatus.Completed || order.status === OrderStatus.Failed;
}

export class RampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RampError';
  }
}

// ---- Card link session -----------------------------------------------------

const startCardLinkSessionResponseSchema = z.object({ linkUrl: z.string().min(1), token: z.string().min(1) });
type StartCardLinkSessionResponse = z.infer<typeof startCardLinkSessionResponseSchema>;

const rampCardSchema = z.object({
  brand: z.nativeEnum(CardBrand).catch(CardBrand.Unspecified),
  id: z.string().min(1),
  lastFourDigits: z.string().min(1),
});
type RampCard = z.infer<typeof rampCardSchema>;

type CompleteCardLinkSessionRequest = { providerCardId: string; brand: CardBrand };

const completeCardLinkSessionResponseSchema = z.object({ card: rampCardSchema });

// protojson drops empty repeated fields, so an account with no cards responds `{}`.
const listCardsResponseSchema = z.object({ cards: z.array(rampCardSchema).default([]) });

const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  [CardBrand.Unspecified]: 'Card',
  [CardBrand.Visa]: 'Visa',
  [CardBrand.Mastercard]: 'Mastercard',
  [CardBrand.Amex]: 'American Express',
  [CardBrand.Discover]: 'Discover',
};

function toLinkedCard({ brand, id, lastFourDigits }: RampCard): LinkedCard {
  return { id, brand: CARD_BRAND_LABELS[brand], last4: lastFourDigits };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof RainbowFetchError && error.response?.status === 401;
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof RainbowFetchError && error.response?.status === 404;
}

/** The backend answered and refused, so the request definitively took no effect. Transport failures and 5xx stay ambiguous. */
export function isDefinitiveRejection(error: unknown): boolean {
  const status = error instanceof RainbowFetchError ? error.response?.status : undefined;
  return status !== undefined && status >= 400 && status < 500;
}

// The user JWT replaces the shared app key on these calls. On 401 the cached
// token is assumed stale: drop it, run one fresh sign-in ceremony, retry once.
// Tokens are acquired outside the try so a 401 from the ceremony's own RPCs
// propagates instead of triggering a second ceremony.
async function authorizedRequest<T>(trigger: CashSignInTrigger, send: (headers: { Authorization: string }) => Promise<T>): Promise<T> {
  const headers = buildAuthenticatedHeader(await ensureAccessToken(trigger));
  try {
    return await send(headers);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    useCashAuthTokenStore.getState().clearToken();
    return send(buildAuthenticatedHeader(await ensureAccessToken(trigger)));
  }
}

export async function startCardLinkSession(abortController?: AbortController | null): Promise<StartCardLinkSessionResponse> {
  const { data } = await authorizedRequest('cardLink', headers =>
    getCashPlatformClient().post('/ramp/payment-methods/link-card-session', {}, { abortController, headers })
  );
  return parseResponse(startCardLinkSessionResponseSchema, data, 'startCardLinkSession');
}

export async function completeCardLinkSession(
  { providerCardId, brand }: CompleteCardLinkSessionRequest,
  abortController?: AbortController | null
): Promise<LinkedCard> {
  const { data } = await authorizedRequest('cardLink', headers =>
    getCashPlatformClient().post(
      '/ramp/payment-methods/link-card-session/complete',
      { brand, providerCardId },
      { abortController, headers }
    )
  );
  return toLinkedCard(parseResponse(completeCardLinkSessionResponseSchema, data, 'completeCardLinkSession').card);
}

export async function listCards(abortController?: AbortController | null): Promise<LinkedCard[]> {
  const { data } = await authorizedRequest('signInScreen', headers =>
    getCashPlatformClient().get('/ramp/payment-methods/cards', { abortController, headers })
  );
  return parseResponse(listCardsResponseSchema, data, 'listCards').cards.map(toLinkedCard);
}

export async function deleteCard(cardId: string, abortController?: AbortController | null): Promise<void> {
  await authorizedRequest('addCash', headers =>
    getCashPlatformClient().delete(`/ramp/payment-methods/${encodeURIComponent(cardId)}`, { abortController, headers })
  );
}

// ---- Wallet link -----------------------------------------------------------

const rampWalletSchema = z.object({ id: z.string().min(1), address: z.string().min(1) });
export type RampWallet = z.infer<typeof rampWalletSchema>;

const listWalletsResponseSchema = z.object({ wallets: z.array(rampWalletSchema).default([]) });
const linkWalletResponseSchema = z.object({ wallet: rampWalletSchema });

export type WalletSignature = {
  /** EIP-191 signature of the link message, 0x-prefixed. */
  hexSignature: string;
  method: WalletSignatureMethod;
  /** Unix seconds as a string (the wire type is int64). Must equal the timestamp inside the signed message. */
  timestamp: string;
};

export async function listWallets(abortController?: AbortController | null): Promise<RampWallet[]> {
  const { data } = await authorizedRequest('addCash', headers =>
    getCashPlatformClient().get('/ramp/wallets', { abortController, headers })
  );
  return parseResponse(listWalletsResponseSchema, data, 'listWallets').wallets;
}

export async function linkWallet(
  { address, signature }: { address: string; signature: WalletSignature },
  abortController?: AbortController | null
): Promise<RampWallet> {
  const { data } = await authorizedRequest('addCash', headers =>
    getCashPlatformClient().post('/ramp/wallets/link', { address, signature }, { abortController, headers })
  );
  return parseResponse(linkWalletResponseSchema, data, 'linkWallet').wallet;
}

// ---- Buy orders ------------------------------------------------------------

const getOrderResponseSchema = z.object({ order: buyOrderSchema });

export async function createBuyOrder(params: CreateBuyOrderParams): Promise<CreatedBuyOrder> {
  if (IS_TESTING === 'true') return e2eCreateBuyOrder(params);

  const { data } = await authorizedRequest('addCash', headers => getCashPlatformClient().post('/ramp/orders/buy', params, { headers }));
  return parseResponse(createdBuyOrderSchema, data, 'createBuyOrder');
}

export async function getOrder(orderId: string, abortController?: AbortController | null): Promise<BuyOrder> {
  if (IS_TESTING === 'true') return e2eGetOrder(orderId);

  const { data } = await authorizedRequest('addCash', headers =>
    getCashPlatformClient().get(`/ramp/orders/${encodeURIComponent(orderId)}`, { abortController, headers })
  );
  return parseResponse(getOrderResponseSchema, data, 'getOrder').order;
}

// ---- E2E buy orders ----------------------------------------------------------
// In-memory stand-in for the two order endpoints: `getOrder` advances one scripted
// step per call, and a `createBuyOrder` replay with a known id returns the existing
// order without re-creating — mirroring the backend's idempotency contract.

const E2E_ORDER_PATH = [OrderStatus.Pending, OrderStatus.Processing, OrderStatus.Processing, OrderStatus.Completed] as const;

type E2EOrderRecord = {
  completedTime?: string;
  createdTime: string;
  cryptoAsset: RampAsset;
  depositAmount: string;
  step: number;
  walletAddress: string;
};

const e2eOrders = new Map<string, E2EOrderRecord>();

function e2eCreateBuyOrder(params: CreateBuyOrderParams): CreatedBuyOrder {
  let record = e2eOrders.get(params.id);
  if (!record) {
    record = {
      createdTime: new Date().toISOString(),
      cryptoAsset: params.cryptoAsset,
      depositAmount: params.depositAmount,
      step: 0,
      walletAddress: params.walletAddress,
    };
    e2eOrders.set(params.id, record);
  }
  return { id: params.id };
}

function e2eGetOrder(orderId: string): BuyOrder {
  const record = e2eOrders.get(orderId);
  if (!record) throw new RampError(`Unknown order ${orderId}`);
  if (record.step < E2E_ORDER_PATH.length - 1) record.step += 1;

  const status = E2E_ORDER_PATH[record.step];
  switch (status) {
    case OrderStatus.Completed:
      record.completedTime ??= new Date().toISOString();
      return {
        id: orderId,
        status,
        // E2E treats USDC as 1:1 with USD; the real backend returns the quoted crypto amount.
        cryptoAmount: { amount: record.depositAmount, asset: record.cryptoAsset },
        fiatAmount: { amount: record.depositAmount, currency: 'USD' },
        createdTime: record.createdTime,
        walletAddress: record.walletAddress,
        transactionHash: `mock-tx-${orderId}`,
        completedTime: record.completedTime,
      };
    case OrderStatus.Processing:
      return { id: orderId, status };
    default:
      return { id: orderId, status: OrderStatus.Pending };
  }
}
