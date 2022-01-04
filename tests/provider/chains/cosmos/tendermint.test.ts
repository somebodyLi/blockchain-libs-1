import BigNumber from 'bignumber.js';
import { Response } from 'cross-fetch';
import { mocked } from 'ts-jest/utils';

import { ResponseError } from '../../../../src/basic/request/exceptions';
import { RestfulRequest } from '../../../../src/basic/request/restful';
import { Tendermint } from '../../../../src/provider/chains/cosmos';
import { TransactionStatus } from '../../../../src/types/provider';

export const okResponse = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify(data)));

jest.mock('../../../../src/basic/request/restful');

const mockRestfulClass = mocked(RestfulRequest, true);

const tendermint = new Tendermint('https://mytendermint.com/api');
const chainInfo: any = {
  implOptions: {
    addressPrefix: 'cosmos',
    mainCoinDenom: 'uatom',
    chainId: 'cosmoshub-4',
  },
};
tendermint.setChainInfo(chainInfo);
const [restful] = mockRestfulClass.mock.instances as Array<any>;

test('getInfo', async () => {
  restful.get.mockImplementation(() =>
    okResponse({
      block: {
        header: {
          height: '8621972',
          time: '2021-12-08T06:03:30.000000000Z',
        },
      },
    }),
  );

  const timer = jest.useFakeTimers();
  timer.setSystemTime(new Date('2021-12-08T06:03:30.000000000Z'));
  await expect(tendermint.getInfo()).resolves.toStrictEqual({
    bestBlockNumber: 8621972,
    isReady: true,
  });

  timer.setSystemTime(new Date('2021-12-08T06:04:00.000000000Z'));
  await expect(tendermint.getInfo()).resolves.toStrictEqual({
    bestBlockNumber: 8621972,
    isReady: true,
  });

  timer.setSystemTime(new Date('2021-12-08T06:0:01.000000000Z'));
  await expect(tendermint.getInfo()).resolves.toStrictEqual({
    bestBlockNumber: 8621972,
    isReady: false,
  });
});

test('getAddress', async () => {
  restful.get.mockReturnValueOnce(
    okResponse({
      account: {
        account_number: '10010',
        sequence: '1',
      },
    }),
  );
  restful.get.mockReturnValueOnce(
    okResponse({
      balances: [
        { denom: 'uatom', amount: '101122' },
        { denom: 'uatom2', amount: '11' },
      ],
    }),
  );

  const address = 'cosmos155svs6sgxe55rnvs6ghprtqu0mh69kehrn0dqr';
  await expect(tendermint.getAddress(address)).resolves.toStrictEqual({
    balance: new BigNumber('101122'),
    existing: true,
    nonce: 1,
    accountNumber: 10010,
  });
  expect(restful.get.mock.calls).toEqual([
    [`/cosmos/auth/v1beta1/accounts/${address}`],
    [`/cosmos/bank/v1beta1/balances/${address}`],
  ]);
});

test('getAddress but not existing', async () => {
  restful.get.mockReturnValueOnce(
    Promise.reject(new ResponseError('', new Response('', { status: 404 }))),
  );
  const address = 'cosmos155svs6sgxe55rnvs6ghprtqu0mh69kehrn0dqr';
  await expect(tendermint.getAddress(address)).resolves.toStrictEqual({
    balance: new BigNumber(0),
    existing: false,
    nonce: 0,
    accountNumber: undefined,
  });
  expect(restful.get).toHaveBeenCalledWith(
    `/cosmos/auth/v1beta1/accounts/${address}`,
  );
});

test('getBalance', async () => {
  restful.get.mockImplementation(() =>
    okResponse({
      balances: [
        { denom: 'uatom', amount: '101122' },
        { denom: 'uatom2', amount: '11' },
      ],
    }),
  );

  const address = 'cosmos155svs6sgxe55rnvs6ghprtqu0mh69kehrn0dqr';
  await expect(
    tendermint.getBalance(address, { tokenAddress: 'uatom' }),
  ).resolves.toStrictEqual(new BigNumber(101122));
  await expect(
    tendermint.getBalance(address, { tokenAddress: 'uatom2' }),
  ).resolves.toStrictEqual(new BigNumber(11));

  expect(restful.get.mock.calls).toEqual([
    [`/cosmos/bank/v1beta1/balances/${address}`],
    [`/cosmos/bank/v1beta1/balances/${address}`],
  ]);
});

test('getFeePricePerUnit - default', async () => {
  await expect(tendermint.getFeePricePerUnit()).resolves.toStrictEqual({
    normal: { price: new BigNumber(250) },
    others: [{ price: new BigNumber(100) }, { price: new BigNumber(400) }],
  });
});

test('getFeePricePerUnit - custom', async () => {
  Object.assign(chainInfo.implOptions, {
    gasPriceStep: {
      normal: 110,
      high: 777,
    },
  });

  await expect(tendermint.getFeePricePerUnit()).resolves.toStrictEqual({
    normal: { price: new BigNumber(110) },
    others: [{ price: new BigNumber(777) }],
  });
  delete chainInfo.implOptions.gasPriceStep;
});

test('getTransactionStatus', async () => {
  restful.get
    .mockReturnValueOnce(
      okResponse({ tx_response: { height: '1010', code: 0 } }),
    )
    .mockReturnValueOnce(okResponse({}))
    .mockReturnValueOnce(
      okResponse({ tx_response: { height: '1011', code: 1 } }),
    )
    .mockReturnValueOnce(
      Promise.reject(new ResponseError('', new Response('', { status: 400 }))),
    );

  await expect(tendermint.getTransactionStatus('fake')).resolves.toBe(
    TransactionStatus.CONFIRM_AND_SUCCESS,
  );
  await expect(tendermint.getTransactionStatus('fake')).resolves.toBe(
    TransactionStatus.PENDING,
  );
  await expect(tendermint.getTransactionStatus('fake')).resolves.toBe(
    TransactionStatus.CONFIRM_BUT_FAILED,
  );
  await expect(tendermint.getTransactionStatus('fake')).resolves.toBe(
    TransactionStatus.NOT_FOUND,
  );
});

test('broadcastTransaction', async () => {
  restful.post.mockReturnValueOnce(
    okResponse({
      tx_response: {
        txhash:
          '10A100C1AF364E42DD729C1163344C1FADE3AF5805EA991FA6A5B038F1B8ACC4',
      },
    }),
  );

  await expect(tendermint.broadcastTransaction('xxxx')).resolves.toBe(true);
  expect(restful.post).toHaveBeenCalledWith(
    '/cosmos/tx/v1beta1/txs',
    {
      mode: 2,
      tx_bytes: 'xxxx',
    },
    true,
  );
});
