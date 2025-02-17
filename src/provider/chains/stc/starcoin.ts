import BigNumber from 'bignumber.js';

import { JsonRPCRequest } from '../../../basic/request/json-rpc';
import { CoinInfo } from '../../../types/chain';
import {
  AddressInfo,
  ClientInfo,
  FeePricePerUnit,
  TransactionStatus,
} from '../../../types/provider';
import { BaseClient } from '../../abc';

const DEFAULT_GAS_LIMIT = 127845;
class StcClient extends BaseClient {
  readonly rpc: JsonRPCRequest;

  constructor(url: string) {
    super();
    this.rpc = new JsonRPCRequest(url);
  }

  async getInfo(): Promise<ClientInfo> {
    const blockInfo: any = await this.rpc.call('chain.info', []);
    const bestBlockNumber = parseInt(blockInfo.head.number);
    const isReady = !isNaN(bestBlockNumber) && bestBlockNumber > 0;

    return { bestBlockNumber, isReady };
  }

  async getAddresses(
    addresses: Array<string>,
  ): Promise<Array<AddressInfo | undefined>> {
    const calls = addresses.reduce((acc: Array<any>, cur) => {
      acc.push([
        'state.get_resource',
        [cur, '0x1::Account::Account', { decode: true }],
      ]);
      acc.push(['txpool.next_sequence_number', [cur]]);
      acc.push([
        'state.get_resource',
        [cur, '0x1::Account::Balance<0x1::STC::STC>', { decode: true }],
      ]);
      return acc;
    }, []);

    const resp: Array<any> = await this.rpc.batchCall(calls);
    const result = [];

    for (let i = 0, count = resp.length; i < count; i += 3) {
      const [state, nextSequenceNumber, _balance] = resp.slice(i, i + 3);
      let info = undefined;

      if (
        typeof state !== 'undefined' &&
        typeof nextSequenceNumber !== 'undefined' &&
        typeof _balance !== 'undefined'
      ) {
        const balance = new BigNumber(_balance?.json.token.value ?? 0);
        const existing = state === null ? false : true;
        const nonce = Math.max(
          state?.json.sequence_number ?? 0,
          nextSequenceNumber ?? 0,
        );
        info = { balance, nonce, existing };
      }

      result.push(info);
    }

    return result;
  }

  async getBalances(
    requests: Array<{ address: string; coin: Partial<CoinInfo> }>,
  ): Promise<Array<BigNumber | undefined>> {
    const calls: Array<any> = requests.map((req) => [
      'state.get_resource',
      [
        req.address,
        `0x1::Account::Balance<${req.coin.tokenAddress ?? '0x1::STC::STC'}>`,
        { decode: true },
      ],
    ]);

    const resps: Array<{ [key: string]: any } | undefined> =
      await this.rpc.batchCall(calls);
    return resps.map((resp) => {
      let balance = undefined;

      if (typeof resp !== 'undefined') {
        balance = new BigNumber(resp?.json.token.value ?? 0);
      }
      return balance;
    });
  }

  async getTransactionStatuses(
    txids: Array<string>,
  ): Promise<Array<TransactionStatus | undefined>> {
    const calls = txids.reduce((acc: Array<any>, cur) => {
      acc.push(['txpool.pending_txn', [cur]]);
      acc.push(['chain.get_transaction_info', [cur]]);
      return acc;
    }, []);

    const resp: Array<any> = await this.rpc.batchCall(calls);

    const result = [];
    for (let i = 0, count = resp.length; i < count; i += 2) {
      const [pendingTx, receipt] = resp.slice(i, i + 2);
      let status = undefined;

      if (typeof receipt !== 'undefined' && typeof pendingTx !== 'undefined') {
        if (pendingTx === null && receipt === null) {
          status = TransactionStatus.NOT_FOUND;
        } else if (pendingTx) {
          status = TransactionStatus.PENDING;
        } else {
          status =
            receipt?.status === 'Executed'
              ? TransactionStatus.CONFIRM_AND_SUCCESS
              : TransactionStatus.CONFIRM_BUT_FAILED;
        }
      }
      result.push(status);
    }

    return result;
  }

  async getFeePricePerUnit(): Promise<FeePricePerUnit> {
    const resp: string = await this.rpc.call('txpool.gas_price', []);
    const price = parseInt(resp ?? '1');
    return {
      normal: { price: new BigNumber(price) },
    };
  }

  async broadcastTransaction(rawTx: string): Promise<boolean> {
    const txid: any = await this.rpc.call('txpool.submit_hex_transaction', [
      rawTx,
    ]);
    return typeof txid === 'string' && txid.length === 66;
  }

  async estimateGasLimit(params: { [key: string]: any }): Promise<BigNumber> {
    const resp: any = await this.rpc.call('contract.dry_run', [params]);
    if (resp?.status === 'Executed') {
      return new BigNumber(parseInt(resp.gas_used));
    } else {
      return new BigNumber(DEFAULT_GAS_LIMIT);
    }
  }
}
export { StcClient };
