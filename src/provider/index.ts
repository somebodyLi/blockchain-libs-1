import BigNumber from 'bignumber.js';

import { checkIsDefined } from '../basic/precondtion';
import { createAnyPromise, createDelayPromise } from '../basic/promise-plus';
import { ChainInfo, CoinInfo } from '../types/chain';
import {
  AddressInfo,
  AddressValidation,
  ClientInfo,
  FeePricePerUnit,
  PartialTokenInfo,
  SignedTx,
  TransactionStatus,
  UnsignedTx,
  UTXO,
} from '../types/provider';
import { Signer, Verifier } from '../types/secret';

import { BaseClient, BaseProvider, ClientFilter } from './abc';

const IMPLS: { [key: string]: any } = {
  algo: require('./chains/algo'),
  cfx: require('./chains/cfx'),
  cosmos: require('./chains/cosmos'),
  eth: require('./chains/eth'),
  sol: require('./chains/sol'),
  stc: require('./chains/stc'),
  near: require('./chains/near'),
};

class ProviderController {
  private clientsCache: { [chainCode: string]: Array<BaseClient> } = {};
  private lastClientCache: { [chainCode: string]: [BaseClient, number] } = {};

  chainSelector: (chainCode: string) => ChainInfo;

  constructor(chainSelector: (chainCode: string) => ChainInfo) {
    this.chainSelector = chainSelector;
  }

  async getClient(
    chainCode: string,
    filter?: ClientFilter,
  ): Promise<BaseClient> {
    filter = filter || (() => true);
    const [lastClient, expiredAt] = this.lastClientCache[chainCode] || [];

    if (
      typeof lastClient !== undefined &&
      expiredAt <= Date.now() &&
      filter(lastClient)
    ) {
      return Promise.resolve(lastClient);
    }

    let clients = this.clientsCache[chainCode];

    if (!clients || clients.length === 0) {
      const chainInfo = this.chainSelector(chainCode);

      const module: any = this.requireChainImpl(chainInfo.impl);
      clients = chainInfo.clients
        .map((config) => [module[config.name], config])
        .filter(([clazz, _]) => typeof clazz != 'undefined')
        .map(([clazz, config]) => new clazz(...config.args));

      for (const client of clients) {
        client.setChainInfo(chainInfo);
      }
      this.clientsCache[chainCode] = clients;
    }

    let client: BaseClient | undefined = undefined;

    try {
      client = await Promise.race([
        createAnyPromise(
          clients.filter(filter).map(async (candidate) => {
            const info = await candidate.getInfo();

            if (!info.isReady) {
              throw Error(
                `${candidate.constructor.name}<${candidate}> is not ready.`,
              );
            }

            return candidate;
          }),
        ),
        createDelayPromise(10000, undefined),
      ]);
    } catch (e) {
      console.error(e);
    }

    if (typeof client === 'undefined') {
      throw Error('No available client');
    }

    this.lastClientCache[chainCode] = [client, Date.now() + 300000]; // Expired at 5 minutes
    return client;
  }

  getProvider(chainCode: string): Promise<BaseProvider> {
    const chainInfo = this.chainSelector(chainCode);
    const { Provider } = this.requireChainImpl(chainInfo.impl);

    return Promise.resolve(
      new Provider(chainInfo, (filter?: ClientFilter) =>
        this.getClient(chainCode, filter),
      ),
    );
  }

  requireChainImpl(impl: string): any {
    return checkIsDefined(IMPLS[impl]);
  }

  getInfo(chainCode: string): Promise<ClientInfo> {
    return this.getClient(chainCode).then((client) => client.getInfo());
  }

  getAddresses(
    chainCode: string,
    address: Array<string>,
  ): Promise<Array<AddressInfo | undefined>> {
    return this.getClient(chainCode).then((client) =>
      client.getAddresses(address),
    );
  }

  async getBalances(
    chainCode: string,
    requests: Array<{ address: string; coin: Partial<CoinInfo> }>,
  ): Promise<Array<BigNumber | undefined>> {
    return this.getClient(chainCode).then((client) =>
      client.getBalances(requests),
    );
  }

  getTransactionStatuses(
    chainCode: string,
    txids: Array<string>,
  ): Promise<Array<TransactionStatus | undefined>> {
    return this.getClient(chainCode).then((client) =>
      client.getTransactionStatuses(txids),
    );
  }

  getFeePricePerUnit(chainCode: string): Promise<FeePricePerUnit> {
    return this.getClient(chainCode).then((client) =>
      client.getFeePricePerUnit(),
    );
  }

  broadcastTransaction(chainCode: string, rawTx: string): Promise<boolean> {
    return this.getClient(chainCode).then((client) =>
      client.broadcastTransaction(rawTx),
    );
  }

  getTokenInfos(
    chainCode: string,
    tokenAddresses: Array<string>,
  ): Promise<Array<PartialTokenInfo | undefined>> {
    return this.getClient(chainCode).then((client) =>
      client.getTokenInfos(tokenAddresses),
    );
  }

  getUTXOs(
    chainCode: string,
    address: Array<string>,
  ): Promise<{ [address: string]: Array<UTXO> }> {
    return this.getClient(chainCode).then((provider) =>
      provider.getUTXOs(address),
    );
  }

  buildUnsignedTx(
    chainCode: string,
    unsignedTx: UnsignedTx,
  ): Promise<UnsignedTx> {
    return this.getProvider(chainCode).then((provider) =>
      provider.buildUnsignedTx(unsignedTx),
    );
  }

  pubkeyToAddress(
    chainCode: string,
    verifier: Verifier,
    encoding: string | undefined,
  ): Promise<string> {
    return this.getProvider(chainCode).then((provider) =>
      provider.pubkeyToAddress(verifier, encoding),
    );
  }

  signTransaction(
    chainCode: string,
    unsignedTx: UnsignedTx,
    signers: { [p: string]: Signer },
  ): Promise<SignedTx> {
    return this.getProvider(chainCode).then((provider) =>
      provider.signTransaction(unsignedTx, signers),
    );
  }

  verifyAddress(
    chainCode: string,
    address: string,
  ): Promise<AddressValidation> {
    return this.getProvider(chainCode).then((provider) =>
      provider.verifyAddress(address),
    );
  }

  verifyTokenAddress(
    chainCode: string,
    address: string,
  ): Promise<AddressValidation> {
    return this.getProvider(chainCode).then((provider) =>
      provider.verifyTokenAddress(address),
    );
  }

  signMessage(
    chainCode: string,
    message: string,
    signer: Signer,
    address?: string,
  ): Promise<string> {
    return this.getProvider(chainCode).then((provider) =>
      provider.signMessage(message, signer, address),
    );
  }

  verifyMessage(
    chainCode: string,
    address: string,
    message: string,
    signature: string,
  ): Promise<boolean> {
    return this.getProvider(chainCode).then((provider) =>
      provider.verifyMessage(address, message, signature),
    );
  }
}

export { ProviderController };
