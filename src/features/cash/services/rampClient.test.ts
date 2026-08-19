import { ResponseParseError } from '@/framework/data/http/parseResponse';
import { RainbowFetchError } from '@/framework/data/http/rainbowFetch';

import { useCashAuthTokenStore } from '../stores/cashAuthTokenStore';
import { getCashPlatformClient } from './cashPlatformClient';
import { ensureAccessToken } from './cashSignInService';
import {
  CardBrand,
  completeCardLinkSession,
  createBuyOrder,
  getOrder,
  linkWallet,
  listWallets,
  OrderFailureReason,
  OrderStatus,
  RampCryptoAsset,
  RampNetwork,
  startCardLinkSession,
  WalletSignatureMethod,
  type BuyOrder,
  type CreateBuyOrderParams,
  type CreatedBuyOrder,
  type WalletSignature,
} from './rampClient';

jest.mock('./cashPlatformClient', () => ({
  getCashPlatformClient: jest.fn(),
  buildAuthenticatedHeader: (token: string) => ({ Authorization: `Bearer ${token}` }),
}));

jest.mock('./cashSignInService', () => ({
  ensureAccessToken: jest.fn(),
}));

const get = jest.fn();
const post = jest.fn();
const mockEnsureAccessToken = ensureAccessToken as jest.Mock;

// `tokenExpiresTime` rides along on the wire but nothing reads it, so the parsed session drops it.
const SESSION = { linkUrl: 'https://link', token: 'vault-token', tokenExpiresTime: '2026-07-24T00:00:00Z' };
const PARSED_SESSION = { linkUrl: SESSION.linkUrl, token: SESSION.token };
const WALLET_SIGNATURE: WalletSignature = {
  hexSignature: '0xsig',
  method: WalletSignatureMethod.EthPersonalSign,
  timestamp: '1750789885',
};
const CREATE_BUY_ORDER_PARAMS: CreateBuyOrderParams = {
  id: '997b3d75-9f76-4038-a173-73c7ff37992f',
  walletAddress: '0x4d957c58d081c1c8c8aafe1e08de047fff19eb88',
  cryptoAsset: { asset: RampCryptoAsset.USDC, network: RampNetwork.ArbitrumTestnet },
  depositAmount: '0.10',
  cardId: '4a2dab9c-3bb6-4c32-8aea-e5fd4ad4c771',
};
const CREATED_TIME = '2026-07-29T16:07:57.965076Z';
const CREATED_BUY_ORDER: CreatedBuyOrder = {
  id: CREATE_BUY_ORDER_PARAMS.id,
};
const PENDING_BUY_ORDER: Extract<BuyOrder, { status: OrderStatus.Pending }> = {
  id: CREATE_BUY_ORDER_PARAMS.id,
  status: OrderStatus.Pending,
};
const PROCESSING_BUY_ORDER: Extract<BuyOrder, { status: OrderStatus.Processing }> = {
  id: CREATE_BUY_ORDER_PARAMS.id,
  status: OrderStatus.Processing,
};
const COMPLETED_BUY_ORDER: Extract<BuyOrder, { status: OrderStatus.Completed }> = {
  id: CREATE_BUY_ORDER_PARAMS.id,
  status: OrderStatus.Completed,
  cryptoAmount: { amount: '0.10', asset: CREATE_BUY_ORDER_PARAMS.cryptoAsset },
  fiatAmount: { amount: '0.10', currency: 'USD' },
  createdTime: CREATED_TIME,
  walletAddress: CREATE_BUY_ORDER_PARAMS.walletAddress,
  transactionHash: '0xtx',
  completedTime: '2026-07-29T16:08:20.000Z',
};
const FAILED_BUY_ORDER: Extract<BuyOrder, { status: OrderStatus.Failed }> = {
  id: CREATE_BUY_ORDER_PARAMS.id,
  status: OrderStatus.Failed,
  failureReason: OrderFailureReason.PaymentRejected,
};

function fetchError(status: number, message: string) {
  return new RainbowFetchError({ message, response: { status } as unknown as Response });
}

beforeEach(() => {
  jest.clearAllMocks();
  (getCashPlatformClient as jest.Mock).mockReturnValue({ get, post });
  mockEnsureAccessToken.mockResolvedValue('jwt-1');
  useCashAuthTokenStore.getState().setToken({ accessToken: 'jwt-1', expiresAt: Date.now() + 60_000 });
  post.mockResolvedValue({ data: SESSION });
});

describe('startCardLinkSession', () => {
  it('sends the user JWT as the bearer', async () => {
    await expect(startCardLinkSession()).resolves.toEqual(PARSED_SESSION);

    expect(mockEnsureAccessToken).toHaveBeenCalledWith('cardLink');
    expect(post).toHaveBeenCalledWith(
      '/ramp/payment-methods/link-card-session',
      {},
      { abortController: undefined, headers: { Authorization: 'Bearer jwt-1' } }
    );
  });

  it('on 401 clears the cached token, signs in again, and retries once', async () => {
    post.mockRejectedValueOnce(fetchError(401, 'unauthorized'));
    mockEnsureAccessToken.mockResolvedValueOnce('jwt-stale').mockResolvedValueOnce('jwt-fresh');

    await expect(startCardLinkSession()).resolves.toEqual(PARSED_SESSION);

    expect(useCashAuthTokenStore.getState().token).toBeNull();
    expect(mockEnsureAccessToken).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][2].headers).toEqual({ Authorization: 'Bearer jwt-fresh' });
  });

  it('propagates a second 401 without further retries', async () => {
    post.mockRejectedValue(fetchError(401, 'unauthorized'));

    await expect(startCardLinkSession()).rejects.toThrow('unauthorized');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('propagates non-401 errors without retrying', async () => {
    post.mockRejectedValue(fetchError(500, 'server error'));

    await expect(startCardLinkSession()).rejects.toThrow('server error');
    expect(post).toHaveBeenCalledTimes(1);
    expect(useCashAuthTokenStore.getState().token).not.toBeNull();
  });
});

describe('completeCardLinkSession', () => {
  it('sends the detected brand and uses the response brand', async () => {
    post.mockResolvedValue({ data: { card: { brand: CardBrand.Visa, id: 'card-1', lastFourDigits: '8990' } } });

    await expect(completeCardLinkSession({ brand: CardBrand.Visa, providerCardId: 'prov-1' })).resolves.toEqual({
      brand: 'Visa',
      id: 'card-1',
      last4: '8990',
    });
    expect(post).toHaveBeenCalledWith(
      '/ramp/payment-methods/link-card-session/complete',
      { brand: CardBrand.Visa, providerCardId: 'prov-1' },
      { abortController: undefined, headers: { Authorization: 'Bearer jwt-1' } }
    );
  });
});

describe('buy orders', () => {
  it('creates a buy order with the authenticated ramp endpoint', async () => {
    post.mockResolvedValue({ data: { ...CREATED_BUY_ORDER, status: 'ORDER_STATUS_NEW', createdTime: CREATED_TIME } });

    await expect(createBuyOrder(CREATE_BUY_ORDER_PARAMS)).resolves.toEqual(CREATED_BUY_ORDER);

    expect(mockEnsureAccessToken).toHaveBeenCalledWith('addCash');
    expect(post).toHaveBeenCalledWith('/ramp/orders/buy', CREATE_BUY_ORDER_PARAMS, {
      headers: { Authorization: 'Bearer jwt-1' },
    });
  });

  it('fetches and unwraps an order by id', async () => {
    const abortController = new AbortController();
    get.mockResolvedValue({ data: { order: PENDING_BUY_ORDER } });

    await expect(getOrder(CREATE_BUY_ORDER_PARAMS.id, abortController)).resolves.toEqual(PENDING_BUY_ORDER);

    expect(mockEnsureAccessToken).toHaveBeenCalledWith('addCash');
    expect(get).toHaveBeenCalledWith(`/ramp/orders/${CREATE_BUY_ORDER_PARAMS.id}`, {
      abortController,
      headers: { Authorization: 'Bearer jwt-1' },
    });
  });
});

// The status decides success from failure and the id addresses every later poll, so a response the
// client cannot read has to fail here — passing it on lands as an unbounded poll or a lost order.
// A completed order is held to the whole Activity entry it has to produce; the other statuses are held
// to what the app actually reads at that status, so a field the backend fills in later cannot strand the order.
describe('response validation', () => {
  it('rejects a created order carrying no id', async () => {
    post.mockResolvedValue({ data: {} });

    await expect(createBuyOrder(CREATE_BUY_ORDER_PARAMS)).rejects.toThrow(ResponseParseError);
  });

  const readableOrders: { label: string; order: BuyOrder }[] = [
    { label: 'pending', order: PENDING_BUY_ORDER },
    { label: 'processing', order: PROCESSING_BUY_ORDER },
    { label: 'completed', order: COMPLETED_BUY_ORDER },
    { label: 'failed', order: FAILED_BUY_ORDER },
  ];

  // Every non-completed fixture carries nothing but its id and status: protojson omits each field the
  // backend has not populated, so that is what an unquoted order looks like on the wire.
  it.each(readableOrders)('accepts a $label order', async ({ order }) => {
    get.mockResolvedValue({ data: { order } });

    await expect(getOrder(CREATE_BUY_ORDER_PARAMS.id)).resolves.toEqual(order);
  });

  const withCryptoAmount = (amount: unknown) => ({
    order: { ...COMPLETED_BUY_ORDER, cryptoAmount: { ...COMPLETED_BUY_ORDER.cryptoAmount, amount } },
  });
  const withAsset = (asset: Record<string, unknown>) => ({
    order: {
      ...COMPLETED_BUY_ORDER,
      cryptoAmount: { ...COMPLETED_BUY_ORDER.cryptoAmount, asset: { ...COMPLETED_BUY_ORDER.cryptoAmount.asset, ...asset } },
    },
  });
  const withoutField = (field: keyof typeof COMPLETED_BUY_ORDER) => {
    const order: Record<string, unknown> = { ...COMPLETED_BUY_ORDER };
    delete order[field];
    return { order };
  };

  const unreadableOrderBodies: { label: string; body: unknown }[] = [
    // rainbowFetch returns the raw text for any body that is not application/json.
    { label: 'a body that is not JSON', body: '<html>502 Bad Gateway</html>' },
    { label: 'an envelope with no order', body: {} },
    { label: 'an order with no status', body: { order: { id: CREATE_BUY_ORDER_PARAMS.id } } },
    { label: 'a status the client cannot act on', body: { order: { ...PENDING_BUY_ORDER, status: 'ORDER_STATUS_REFUNDED' } } },
    { label: 'a completed order with no transaction hash', body: withoutField('transactionHash') },
    { label: 'a completed order with no wallet address', body: withoutField('walletAddress') },
    { label: 'a completed order with no fiat amount', body: withoutField('fiatAmount') },
    { label: 'a completed order with no crypto amount', body: withoutField('cryptoAmount') },
    { label: 'a completed order with an unknown asset', body: withAsset({ asset: 'CRYPTO_ASSET_ETH' }) },
    { label: 'a completed order with an unknown network', body: withAsset({ network: 'NETWORK_SOLANA' }) },
    { label: 'a completed order with an unspecified asset', body: withAsset({ asset: RampCryptoAsset.Unspecified }) },
    { label: 'a completed order with an unspecified network', body: withAsset({ network: RampNetwork.Unspecified }) },
    { label: 'a completed order with a zero crypto amount', body: withCryptoAmount('0') },
    { label: 'a completed order with a negative crypto amount', body: withCryptoAmount('-1') },
    { label: 'a completed order with a malformed crypto amount', body: withCryptoAmount('not-a-number') },
  ];

  it.each(unreadableOrderBodies)('rejects $label', async ({ body }) => {
    get.mockResolvedValue({ data: body });

    await expect(getOrder(CREATE_BUY_ORDER_PARAMS.id)).rejects.toThrow(ResponseParseError);
  });

  // Flattening this to UNSPECIFIED would erase a reason the backend shipped ahead of the client from analytics.
  it('passes through a failure reason the client does not model', async () => {
    get.mockResolvedValue({ data: { order: { ...FAILED_BUY_ORDER, failureReason: 'ORDER_FAILURE_REASON_FRAUD' } } });

    await expect(getOrder(CREATE_BUY_ORDER_PARAMS.id)).resolves.toMatchObject({
      status: OrderStatus.Failed,
      failureReason: 'ORDER_FAILURE_REASON_FRAUD',
    });
  });

  it('falls back to unspecified when a failed order carries no reason', async () => {
    get.mockResolvedValue({ data: { order: { id: CREATE_BUY_ORDER_PARAMS.id, status: OrderStatus.Failed } } });

    await expect(getOrder(CREATE_BUY_ORDER_PARAMS.id)).resolves.toMatchObject({ failureReason: OrderFailureReason.Unspecified });
  });

  it('accepts a card brand the client does not model', async () => {
    post.mockResolvedValue({ data: { card: { brand: 'CARD_BRAND_JCB', id: 'card-1', lastFourDigits: '8990' } } });

    await expect(completeCardLinkSession({ brand: CardBrand.Unspecified, providerCardId: 'prov-1' })).resolves.toEqual({
      brand: 'Card',
      id: 'card-1',
      last4: '8990',
    });
  });

  it('rejects a card-link session with no vault url', async () => {
    post.mockResolvedValue({ data: { token: 'vault-token' } });

    await expect(startCardLinkSession()).rejects.toThrow(ResponseParseError);
  });

  it('rejects a linked wallet with no address', async () => {
    post.mockResolvedValue({ data: { wallet: { id: 'wallet-1' } } });

    await expect(linkWallet({ address: '0xabc', signature: WALLET_SIGNATURE })).rejects.toThrow(ResponseParseError);
  });

  it('reads an empty wallet list from an empty envelope', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listWallets()).resolves.toEqual([]);
  });
});
